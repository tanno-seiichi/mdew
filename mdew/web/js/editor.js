// 編集部分。ブラウザ標準の編集機能（contenteditable）の上に、mde と同じ操作を自前で作る。
//
// 主な仕組み：
//  - 非破壊保存：読み込んだ時の最上位のブロック（段落・見出し・リスト・表など）ごとに、元テキストの
//    範囲を覚えておく（m_info）。中身が変わったブロックは MutationObserver で印を付け（m_dirty）、
//    保存時には印の無いブロックは元テキストを、印のあるブロックと新しいブロックだけを
//    markdown.js の serializeBlock で書き出す。
//  - 元に戻す：ブラウザ標準の「元に戻す」は、プログラムで書き換えた部分（「# 」で見出しにする等）と
//    相性が悪いため使わず、編集の区切りごとに最上位のブロックの複製を残す方式で自前で行う。
//  - 入力時の書式変換：行頭の「# 」「- 」「1. 」「> 」「[ ] 」、閉じ側の「**」「*」「~~」「==」「`」を
//    打った時に、見た目の書式に変換する（IME で変換中は何もしない）。
//  - 右クリックのメニュー：切り取り・コピー・貼り付け、文字の書式、表の操作（showMenu で自前のメニューを出す）。
//  - 貼り付け：文字は Markdown として読み、書式にして貼る（Ctrl+Shift+V は書式なし）。Excel 等の表は表にして貼る。
//  - コピー：他のアプリ向けの HTML と、mdew どうしで書式を保つ Markdown も一緒にコピーする（clipboard.js）。
//  - 画像：ダブルクリック・右クリックの「画像を開く」で、既定のアプリで開く（ホストが開く）。
import { parseBlocks, renderBlock, renderInline, serializeBlock, imageSource, RE_BARE_EMAIL, RE_EMAIL_PREV_CHAR } from './markdown.js';
import {
  MARKDOWN_MIME, setClipboardData, writeClipboard, lastCopiedMarkdown, buildCopyData, buildExcelCopy, buildTableCopy,
  tableFromHtml, tableFromTsv, rowsToMarkdownTable, imageSourcesInRows, cellMarkdown, htmlToMarkdown,
} from './clipboard.js';

/** 文字を書く単位の要素（カーソルのある「行」を探す時に使う）。 */
const TEXT_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,pre,td,th,div.md-raw';
/** 「元に戻す」で戻れる回数。 */
const UNDO_LIMIT = 200;
/** この時間（ミリ秒）以内に続けて打った文字は、「元に戻す」1回分にまとめる。 */
const TYPING_GROUP_MS = 1000;

/**
 * 編集領域。1つの文書の表示・編集・Markdown への書き出しを担当する。
 * ファイルの読み書きやホストとのやり取りは行わず、必要な時は a_handlers の関数で main.js に知らせる。
 */
export class Editor {
  /**
   * @param {HTMLElement} a_root 編集領域（contenteditable にする要素）
   * @param {object} a_handlers main.js に知らせるための関数
   * @param {() => void} a_handlers.onChange 内容が変わった（未保存の表示・アウトラインの更新用）
   * @param {(file: File) => void} a_handlers.onPasteImage 画像が貼り付けられた（ホストに保存を依頼する）
   * @param {(href: string) => void} a_handlers.onOpenLink リンクがクリックされた
   * @param {(href: string|null) => void} a_handlers.onHoverLink リンクの上にマウスが乗った（離れたら null）
   * @param {(message: string) => void} a_handlers.onError 利用者に知らせるエラー
   * @param {(src: string) => void} a_handlers.onOpenImage 画像を既定のアプリで開く（書かれたままの参照先）
   * @param {(img: HTMLImageElement) => string|null} a_handlers.imageFileUrl 画像のファイルの場所（file:///…・
   *   http…。他のアプリへのコピー用。分からなければ null）
   * @param {(srcs: string[]) => Promise<(string|null)[]>} a_handlers.importImages 他のアプリが置いた画像のファイル
   *   （Excel の一時ファイル等）を、貼り付けた画像としてホストにコピーしてもらう（URL を返す。コピーできなければ null）
   */
  constructor(a_root, a_handlers) {
    this.m_root = a_root;
    this.m_handlers = a_handlers;
    /** 最上位のブロック → 読み込み時の情報 {index:何番目のブロックか, start, end:元テキストの中の位置}。 */
    this.m_info = new WeakMap();
    /** 読み込み後（保存後）に中身が変わった最上位のブロック。 */
    this.m_dirty = new WeakSet();
    /** 元テキスト {source:読み込んだ（保存した）Markdown, lastIndex:最後のブロックの番号}。新規の文書は null。 */
    this.m_original = null;
    /** 新しく作る箇条書きの記号（文書で最も多く使われているもの）。 */
    this.m_bullet = '-';
    /** 「元に戻す」「やり直し」用の状態（snapshot）の履歴。 */
    this.m_undo = [];
    this.m_redo = [];
    /** 直前の checkpoint の種類と時刻（続けて打った文字をまとめるため）。 */
    this.m_lastKind = null;
    this.m_lastTime = 0;
    /** IME で変換中か。 */
    this.m_composing = false;
    /** 画像を貼り付けた時のカーソル位置（ホストが画像を保存し終えたら、ここに挿入する）。 */
    this.m_pasteRange = null;
    /** マウスのボタンを押した位置（クリックとドラッグを区別するため）。 */
    this.m_mouseDown = null;
    /** Ctrl+Shift+V（書式なしで貼り付け）が押されたか（続いて起きる paste で使う）。 */
    this.m_pastePlain = false;

    // 編集できるようにする（スペルチェックの波線は出さない。Enter で作る新しい行は <p> にする）
    a_root.contentEditable = 'true';
    a_root.spellcheck = false;
    document.execCommand('defaultParagraphSeparator', false, 'p');

    // 変更の監視（observe で開始）と、入力・キー・マウスのイベント
    this.m_observer = new MutationObserver((a_records) => this.markDirty(a_records));
    a_root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    a_root.addEventListener('input', (e) => this.onInput(e));
    a_root.addEventListener('keydown', (e) => this.onKeyDown(e));
    a_root.addEventListener('compositionstart', () => { this.m_composing = true; this.checkpoint('typing'); });
    a_root.addEventListener('compositionend', () => {
      this.m_composing = false;
      // 確定した文字に対して、書式の変換を行う
      setTimeout(() => this.applyInputRules(), 0);
    });
    a_root.addEventListener('paste', (e) => this.onPaste(e));
    a_root.addEventListener('copy', (e) => this.onCopy(e, false));
    a_root.addEventListener('cut', (e) => this.onCopy(e, true));
    // 画像のダブルクリック：既定のアプリで開く（mde と同じ）
    a_root.addEventListener('dblclick', (e) => {
      if ('IMG' === e.target.tagName && this.m_root.contains(e.target)) {
        e.preventDefault();
        this.m_handlers.onOpenImage(imageSource(e.target));
      }
    });
    // リンクを開くのは、マウスを押した位置から動かさずに離した時だけ（ドラッグでの選択と区別する。onClick 参照）
    a_root.addEventListener('mousedown', (e) => { this.m_mouseDown = { x: e.clientX, y: e.clientY }; });
    // ドラッグでの範囲選択：マウスがブロックの間の余白（段落・リスト等の margin）にある時の選択の位置を直す（adjustDragFocus）
    a_root.addEventListener('mousedown', (e) => {
      this.m_dragSelecting = 0 === e.button && !(e.target.closest && e.target.closest('input,img'));
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.m_dragSelecting) return;
      if (!(e.buttons & 1)) {
        this.m_dragSelecting = false;
        return;
      }
      // ブラウザが選択を広げた後（同じ描画の前）に直す
      const x = e.clientX;
      const y = e.clientY;
      cancelAnimationFrame(this.m_dragFrame);
      this.m_dragFrame = requestAnimationFrame(() => this.adjustDragFocus(x, y));
    });
    document.addEventListener('mouseup', () => { this.m_dragSelecting = false; });
    a_root.addEventListener('click', (e) => this.onClick(e));
    a_root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // リンクの上にマウスを乗せた時に、ステータスバーへリンク先を出す（文書の要素には手を加えない）
    a_root.addEventListener('mouseover', (e) => {
      const link = e.target.closest && e.target.closest('a[href]');
      this.m_handlers.onHoverLink(link && this.m_root.contains(link) ? link.getAttribute('href') : null);
    });
  }

  /**
   * ドラッグでの範囲選択で、マウスがブロックの間の余白（段落・見出し・リスト等の上下の margin）や、編集領域の余白に
   * ある時に、選択の端を、上下でいちばん近い行の、マウスの横位置にする。
   * ブラウザは、ブロックの間の余白の位置を「次のブロックの先頭」とみなすため、行の末尾より右へドラッグしている時に
   * マウスが少し上にずれて余白に入ると、選択の端が行の先頭に飛び、選択が消えたように見える（行の先頭から
   * ドラッグした場合）。
   * @param {number} a_x マウスの位置（clientX）
   * @param {number} a_y マウスの位置（clientY）
   */
  adjustDragFocus(a_x, a_y) {
    const hit = document.elementFromPoint(a_x, a_y);
    if (!hit || !(hit === this.m_root || (this.m_root.contains(hit) && /^(?:UL|OL|BLOCKQUOTE)$/.test(hit.tagName)))) return;
    const sel = getSelection();
    if (!sel.rangeCount || !this.m_root.contains(sel.anchorNode)) return;
    // 上下でいちばん近い、文字を書く単位の要素（同じ近さなら、後ろの要素＝入れ子の内側）
    let best = null;
    let bestDist = Infinity;
    for (const el of this.m_root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,table,div.md-raw')) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      const dist = a_y < r.top ? r.top - a_y : (a_y > r.bottom ? a_y - r.bottom : 0);
      if (dist <= bestDist) {
        best = el;
        bestDist = dist;
      }
    }
    if (!best) return;
    // マウスの位置を、その要素の中に収めて、文字の位置を求める
    const r = best.getBoundingClientRect();
    const x = Math.min(Math.max(a_x, r.left + 1), r.right - 1);
    const y = Math.min(Math.max(a_y, r.top + 1), r.bottom - 1);
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) ({ offsetNode: node, offset } = pos);
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) ({ startContainer: node, startOffset: offset } = range);
    }
    if (!node || !this.m_root.contains(node) || node === this.m_root) return;
    if (sel.focusNode === node && sel.focusOffset === offset) return;
    sel.extend(node, offset);
  }

  // ===== 読み込み・保存 =====

  /**
   * Markdown を読み込んで表示する。「元に戻す」の履歴は消え、カーソルは先頭に置く。
   * @param {string} a_markdown 文書の全体（改行は LF、BOM なし）。新規の文書は ''
   */
  load(a_markdown) {
    this.m_observer.disconnect();
    this.m_bullet = detectBulletMarker(a_markdown);
    const blocks = a_markdown ? parseBlocks(a_markdown) : [];
    this.m_info = new WeakMap();
    this.m_dirty = new WeakSet();
    const fragment = document.createDocumentFragment();
    const template = document.createElement('template');
    blocks.forEach((b, i) => {
      template.innerHTML = renderBlock(b);
      const nodes = [...template.content.children];
      if (nodes[0]) this.m_info.set(nodes[0], { index: i, start: b.start, end: b.end });
      fragment.append(...nodes);
    });
    this.m_root.replaceChildren(fragment);
    this.m_original = a_markdown ? { source: a_markdown, lastIndex: blocks.length - 1 } : null;
    this.ensureTrailingParagraph();
    this.m_undo = [];
    this.m_redo = [];
    this.m_lastKind = null;
    this.observe();
    this.setCaret({ index: 0, offset: 0 });
  }

  /**
   * 現在の内容を Markdown にする。編集していないブロックは元テキストのまま。
   * @returns {{text:string, positions:{el:HTMLElement,start:number,end:number}[]}}
   *   text は文書の全体の Markdown（改行は LF）。positions は書き出した各ブロックの text の中の位置で、
   *   保存後に元テキストとして取り込み直すために使う（markSaved）。
   */
  serialize() {
    // 最上位のブロックを順に書き出す。前のブロックと読み込み時に隣どうしだった場合は、間の空行の数なども
    // 元テキストのままにする
    const source = this.m_original ? this.m_original.source : '';
    const lastIndex = this.m_original ? this.m_original.lastIndex : -1;
    const opts = { bullet: this.m_bullet };
    let out = '';
    let prev = null;
    let lastInfo = null;
    const positions = [];
    for (const el of this.m_root.children) {
      const info = this.m_info.get(el);
      const changed = !info || this.m_dirty.has(el);
      const text = changed ? serializeBlock(el, opts) : source.slice(info.start, info.end);
      if ('' === text) continue; // 空の段落（Enter で作っただけの行など）は書き出さない
      if (0 === positions.length) {
        // 先頭のブロックが読み込み時の先頭のままなら、その前にあった元テキスト（空行等）も残す
        if (info && 0 === info.index) out += source.slice(0, info.start);
      } else if (info && prev && info.index === prev.index + 1) {
        out += source.slice(prev.end, info.start); // 元の区切り（空行の数など）
      } else {
        out += '\n\n';
      }
      const start = out.length;
      out += text;
      positions.push({ el, start, end: out.length });
      prev = info || null;
      lastInfo = info || null;
    }
    // 最後のブロックが読み込み時の最後のままなら、その後ろの元テキスト（末尾の改行の有無など）も残す
    if (lastInfo && lastInfo.index === lastIndex) {
      out += source.slice(lastInfo.end);
    } else if (out.length > 0 && /\n$/.test(source || '\n')) {
      out += '\n';
    }
    return { text: out, positions };
  }

  /**
   * 保存した内容を、新しい「元テキスト」として取り込み直す（以降も最小限の差分で保存するため）。
   * @param {{text:string, positions:{el:HTMLElement,start:number,end:number}[]}} a_result 保存した時の serialize の結果
   */
  markSaved(a_result) {
    this.m_original = { source: a_result.text, lastIndex: a_result.positions.length - 1 };
    this.m_info = new WeakMap();
    a_result.positions.forEach((p, i) => this.m_info.set(p.el, { index: i, start: p.start, end: p.end }));
    this.m_dirty = new WeakSet();
  }

  // ===== 画像 =====

  /**
   * 文書内の画像の参照先（「名前を付けて保存」で画像をコピーするために使う）。
   * @returns {string[]} img の src 属性の値（重複なし。書かれたままの相対パス・URL）
   */
  collectImageSources() {
    return [...new Set([...this.m_root.querySelectorAll('img')].map((img) => imageSource(img)).filter(Boolean))];
  }

  /**
   * 保存時にホストが画像を移した結果に合わせて、画像の参照先を書き換える。
   * @param {Object<string,string>|null} a_replacements 元の参照先 → 新しい参照先。無ければ null
   */
  applyImageSrcReplacements(a_replacements) {
    if (!a_replacements) return;
    for (const img of this.m_root.querySelectorAll('img')) {
      const src = imageSource(img);
      if (!Object.prototype.hasOwnProperty.call(a_replacements, src)) continue;
      const next = a_replacements[src];
      img.removeAttribute('data-src');
      img.setAttribute('src', next);
      // HTML のタグで書かれていた画像は、書き出すタグの中の参照先も書き換える（ホストの ReplaceImageReference と同じ）
      if (img.dataset.html) img.dataset.html = img.dataset.html.split(`src="${src}"`).join(`src="${next}"`).split(`src='${src}'`).join(`src='${next}'`);
    }
  }

  /**
   * ホストが一時フォルダに保存した、貼り付けた画像を挿入する（貼り付けた時のカーソル位置に）。
   * @param {string} a_url 画像の参照先（一時フォルダの画像は https://tmp.mdew/...）
   * @param {string} a_alt 画像の代替テキスト
   */
  insertImage(a_url, a_alt) {
    this.checkpoint('edit');
    const sel = getSelection();
    let range = this.m_pasteRange && this.m_root.contains(this.m_pasteRange.startContainer) ? this.m_pasteRange : null;
    if (!range && sel.rangeCount && this.m_root.contains(sel.anchorNode)) range = sel.getRangeAt(0);
    if (!range) return;
    range.deleteContents();
    const img = document.createElement('img');
    img.setAttribute('src', a_url);
    img.setAttribute('alt', a_alt || '');
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.m_pasteRange = null;
    this.changed();
  }

  /**
   * アウトライン用の見出しの一覧。
   * @returns {HTMLElement[]} 最上位の h1〜h6 要素（文書の順）
   */
  headings() {
    return [...this.m_root.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')];
  }

  /** 編集領域にキーボードの入力先を移す（カーソル位置はそのまま）。 */
  focus() {
    this.m_root.focus();
  }

  // ===== 変更の追跡 =====

  /** 編集領域の変更の監視を始める（markDirty が呼ばれるようになる）。 */
  observe() {
    this.m_observer.observe(this.m_root, { childList: true, subtree: true, characterData: true, attributes: true });
  }

  /**
   * 変更のあった最上位のブロックに印を付ける（MutationObserver から呼ばれる）。
   * @param {MutationRecord[]} a_records 変更の記録
   */
  markDirty(a_records) {
    for (const r of a_records) {
      let node = r.target;
      if (node === this.m_root) continue; // 最上位のブロックの追加・削除（追加されたものは m_info が無いので新規扱い）
      while (node && node.parentNode !== this.m_root) node = node.parentNode;
      if (node) this.m_dirty.add(node);
    }
  }

  /** 編集した後の共通の処理（末尾の段落を保ち、main.js に変更を知らせる）。 */
  changed() {
    this.ensureTrailingParagraph();
    this.ensureOwnLines();
    this.m_handlers.onChange();
  }

  /**
   * 入れ子のリストだけを持つ空の項目に、項目自身の行を作る（ensureOwnLine）。親の項目の文字を消した時・
   * 文字のある項目の末尾で Enter を押して入れ子のリストが新しい項目に移った時等、どの編集でできた場合でも、
   * 項目の記号と入れ子のリストの記号が同じ行に並ばないようにする。日本語の入力の途中では行わない。
   */
  ensureOwnLines() {
    if (this.m_composing) return;
    for (const list of this.m_root.querySelectorAll('li > :is(ul,ol):first-child, li > input:first-child + :is(ul,ol)')) ensureOwnLine(list.parentElement);
  }

  /** 文書の最後が表・コードブロック等の場合、その後ろにカーソルを置けるよう空の段落を置く。 */
  ensureTrailingParagraph() {
    const last = this.m_root.lastElementChild;
    if (!last || 'P' !== last.tagName) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      this.m_root.appendChild(p);
    }
  }

  // ===== 元に戻す・やり直し =====

  /**
   * 「元に戻す」用に、今の状態を記録する（最上位のブロックの複製・元テキストの情報・カーソル位置）。
   * @returns {{blocks:{node:Node, info:object, dirty:boolean}[], original:object, caret:object}}
   */
  snapshot() {
    return {
      blocks: [...this.m_root.children].map((el) => ({ node: el.cloneNode(true), info: this.m_info.get(el), dirty: this.m_dirty.has(el) })),
      original: this.m_original,
      caret: this.getCaret(),
    };
  }

  /**
   * snapshot で記録した状態に戻す。
   * @param {object} a_snapshot snapshot の戻り値
   */
  restore(a_snapshot) {
    this.m_observer.disconnect();
    this.m_root.replaceChildren(...a_snapshot.blocks.map((b) => {
      const node = b.node.cloneNode(true);
      if (b.info) this.m_info.set(node, b.info);
      if (b.dirty) this.m_dirty.add(node);
      return node;
    }));
    this.m_original = a_snapshot.original;
    this.observe();
    if (a_snapshot.caret) this.setCaret(a_snapshot.caret);
  }

  /**
   * 編集の直前の状態を「元に戻す」用に残す。続けて文字を打っている間（a_kind が 'typing' で、
   * 前の入力から1秒以内）は、ひとまとまりとして扱い、残さない。
   * @param {'typing'|'edit'} a_kind 'typing'：文字の入力・削除、'edit'：それ以外の編集（書式の変換、改行等）
   */
  checkpoint(a_kind) {
    const now = performance.now();
    if ('typing' === a_kind && 'typing' === this.m_lastKind && now - this.m_lastTime < TYPING_GROUP_MS) {
      this.m_lastTime = now;
      return;
    }
    this.m_undo.push(this.snapshot());
    if (this.m_undo.length > UNDO_LIMIT) this.m_undo.shift();
    this.m_redo = [];
    this.m_lastKind = a_kind;
    this.m_lastTime = now;
  }

  /** 元に戻す（Ctrl+Z）。 */
  undo() {
    if (0 === this.m_undo.length) return;
    this.m_redo.push(this.snapshot());
    this.restore(this.m_undo.pop());
    this.m_lastKind = null;
    this.changed();
  }

  /** やり直し（Ctrl+Y・Ctrl+Shift+Z）。 */
  redo() {
    if (0 === this.m_redo.length) return;
    this.m_undo.push(this.snapshot());
    this.restore(this.m_redo.pop());
    this.m_lastKind = null;
    this.changed();
  }

  // ===== カーソル位置 =====

  /**
   * カーソル位置を「最上位の何番目のブロックの、何文字目か」で表す（元に戻す時の復元用）。
   * @returns {{index:number, offset:number}|null} カーソルが編集領域の外なら null
   */
  getCaret() {
    const sel = getSelection();
    if (!sel.rangeCount || !this.m_root.contains(sel.anchorNode)) return null;
    let block = sel.anchorNode;
    while (block && block.parentNode !== this.m_root) block = block.parentNode;
    if (!block) return null;
    const range = document.createRange();
    range.setStart(block, 0);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return { index: [...this.m_root.children].indexOf(block), offset: range.toString().length };
  }

  /**
   * getCaret で表したカーソル位置にカーソルを置く。ブロックや文字が足りない場合は、置ける一番近い位置に置く。
   * @param {{index:number, offset:number}} a_caret カーソル位置
   */
  setCaret(a_caret) {
    const blocks = this.m_root.children;
    if (0 === blocks.length) return;
    const block = blocks[Math.min(a_caret.index, blocks.length - 1)];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remain = a_caret.offset;
    let node;
    const range = document.createRange();
    let placed = false;
    while ((node = walker.nextNode())) {
      if (remain <= node.data.length) {
        range.setStart(node, remain);
        placed = true;
        break;
      }
      remain -= node.data.length;
    }
    if (!placed) {
      const target = block.querySelector('li,td,th') || block;
      range.selectNodeContents(target);
      range.collapse(!walker.currentNode || 0 === a_caret.offset);
    }
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * カーソルのある、文字を書く単位の要素（段落・見出し・リストの項目・表のセル等）。
   * @returns {HTMLElement|null} カーソルが編集領域の外なら null
   */
  currentTextBlock() {
    const sel = getSelection();
    if (!sel.rangeCount || !this.m_root.contains(sel.anchorNode)) return null;
    const node = 3 === sel.anchorNode.nodeType ? sel.anchorNode.parentElement : sel.anchorNode;
    const block = node.closest(TEXT_BLOCK_SELECTOR);
    return block && this.m_root.contains(block) ? block : null;
  }

  /**
   * a_block の先頭からカーソルまでの文字（入れ子のリストの中は含めない）。
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   * @returns {string} 改行しない空白・全角の空白は半角の空白に、目印のゼロ幅の空白は取り除いたもの
   */
  textBeforeCaret(a_block) {
    const sel = getSelection();
    const range = document.createRange();
    range.setStart(a_block, 0);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    // 全角の空白（IME がオンの時に打たれる空白）も、半角の空白と同じに扱う
    return range.toString().replace(/[\u00a0\u3000]/g, ' ').replace(/\u200b/g, '');
  }

  /**
   * a_block の先頭からカーソルまでの文字を削除する（「# 」などの記号を消すため）。
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   */
  deleteBeforeCaret(a_block) {
    const sel = getSelection();
    const range = document.createRange();
    range.setStart(a_block, 0);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    range.deleteContents();
  }

  /**
   * 要素の先頭にカーソルを置く。チェックボックスの項目は、チェックボックスの右側に置く。
   * @param {HTMLElement} a_el 段落・見出し・リストの項目・表のセル等
   */
  placeCaretAtStart(a_el) {
    // 中身が空だと高さが無くなり、カーソルを置けないため、空の文字は取り除いて <br> を置く
    for (const n of [...a_el.childNodes]) if (3 === n.nodeType && '' === n.data) n.remove();
    if ('' === a_el.textContent && !a_el.querySelector('br,img')) a_el.appendChild(document.createElement('br'));
    // 入れ子のリストだけを持つ空の項目：項目自身の行（<br>）を作って、そこに置く（入れ子の項目の中に置かない）
    const ownBreak = 'LI' === a_el.tagName ? ensureOwnLine(a_el) : null;
    const range = document.createRange();
    const box = a_el.firstChild && 'INPUT' === a_el.firstChild.nodeName ? a_el.firstChild : null;
    if (box) {
      // チェックボックスの項目は、チェックボックスの右側にカーソルを置く（目印のゼロ幅の空白の後ろ。
      // 何も無い位置だと、ブラウザがチェックボックスの左にカーソルを置いてしまうため）
      let text = box.nextSibling;
      if (!text || 3 !== text.nodeType) {
        text = document.createTextNode('\u200b');
        box.after(text);
      } else if (!text.data.startsWith('\u200b')) {
        text.insertData(0, '\u200b');
      }
      range.setStart(text, 1);
    } else if (ownBreak) {
      range.setStartBefore(ownBreak);
    } else {
      const walker = document.createTreeWalker(a_el, NodeFilter.SHOW_TEXT, {
        // リストの項目の場合、入れ子のリストの中の文字には置かない
        acceptNode: (n) => ('LI' !== a_el.tagName || n.parentElement.closest('li') === a_el
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      const text = walker.nextNode();
      if (text) range.setStart(text, 0);
      else range.setStart(a_el, 0);
    }
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * カーソル位置に文字を挿入する（コードブロックの改行・タブ用。ブラウザの insertText は
   * 改行でコードブロックを分割してしまうため、直接書き込む）。選択範囲がある場合は置き換える。
   * @param {string} a_text 挿入する文字
   */
  insertTextAtCaret(a_text) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    let node = range.startContainer;
    let offset = range.startOffset;
    if (3 !== node.nodeType) {
      const text = document.createTextNode('');
      node.insertBefore(text, node.childNodes[offset] || null);
      node = text;
      offset = 0;
    }
    node.insertData(offset, a_text);
    range.setStart(node, offset + a_text.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 指定した範囲を文字に置き換える（検索と置換の 1件ずつ置換用。find.js 参照）。
   * 「元に戻す」で1回で戻せるよう、まとめて1つの操作にする。後ろの範囲から順に置き換える（前の範囲の位置がずれないように）。
   * @param {{range: Range, text: string}[]} a_items 置き換える範囲と文字（文書の順）
   * @returns {Range|null} 最初の範囲を置き換えた文字の直後の位置（次の箇所を探す基準に使う）
   */
  replaceRanges(a_items) {
    if (!a_items.length) return null;
    this.checkpoint('edit');
    let after = null;
    for (let i = a_items.length - 1; i >= 0; i--) {
      const { range, text } = a_items[i];
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      if (0 === i) {
        after = document.createRange();
        after.setStartAfter(node);
        after.collapse(true);
      }
    }
    this.changed();
    return after;
  }

  /**
   * コードブロックの最後で改行した後に、カーソルのある新しい行が画面に出るようにする。
   * 末尾の改行の後ろは画面上の行にならず、そこに打った文字が前の行に付いてしまうため、目印の改行を
   * もう1つ後ろに置く（保存時に1つだけ取り除く。markdown.js の serializeBlock 参照）。
   * @param {HTMLElement} a_block コードブロック（pre）
   */
  keepLastLineInCode(a_block) {
    const sel = getSelection();
    const rest = document.createRange();
    rest.setStart(sel.anchorNode, sel.anchorOffset);
    rest.setEnd(a_block, a_block.childNodes.length);
    if ('' === rest.toString() && 3 === sel.anchorNode.nodeType) {
      sel.anchorNode.insertData(sel.anchorOffset, '\n');
    }
  }

  /**
   * 表のセルの間を移動する。最後のセルで Tab を押した時は、行を1行追加する。
   * @param {HTMLElement} a_cell 今のセル
   * @param {boolean} a_backward 前のセルへ移動するか（Shift+Tab）
   * @returns {boolean} 表を変更したか（行を追加した場合だけ true）
   */
  moveToCell(a_cell, a_backward) {
    const table = a_cell.closest('table');
    const cells = [...table.querySelectorAll('th,td')];
    let k = cells.indexOf(a_cell) + (a_backward ? -1 : 1);
    if (k < 0) return false;
    if (k >= cells.length) {
      this.checkpoint('edit');
      const columns = table.rows[0].cells.length;
      const row = (table.tBodies[0] || table.createTBody()).insertRow();
      for (let c = 0; c < columns; c++) row.insertCell().appendChild(document.createElement('br'));
      this.placeCaretAtStart(row.cells[0]);
      return true;
    }
    const target = cells[k];
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return false;
  }

  // ===== 入力のイベント =====

  /**
   * 入力の直前（beforeinput）。ブラウザ標準の「元に戻す」・書式の操作を止め、編集の前の状態を残す。
   * @param {InputEvent} e
   */
  onBeforeInput(e) {
    if ('historyUndo' === e.inputType) { e.preventDefault(); this.undo(); return; }
    if ('historyRedo' === e.inputType) { e.preventDefault(); this.redo(); return; }
    if (e.isComposing) return;
    if (e.inputType.startsWith('format')) {
      // 書式はショートカット・右クリックのメニューから applyFormat で行う（ブラウザ標準の書式の操作は使わない）
      e.preventDefault();
      return;
    }
    this.checkpoint(/^(insertText|deleteContent)/.test(e.inputType) ? 'typing' : 'edit');
  }

  /**
   * 入力の直後（input）。改行の後処理と、入力した文字による書式の変換を行う。
   * @param {InputEvent} e
   */
  onInput(e) {
    if ('insertParagraph' === e.inputType) this.afterNewParagraph();
    if ('insertLineBreak' === e.inputType) this.markSoftBreak();
    if (!e.isComposing && !this.m_composing && 'insertText' === e.inputType) this.applyInputRules();
    this.changed();
  }

  /**
   * Shift+Enter で入れた改行は、Markdown のソースの改行（1行の終わり）として保存する。
   * 印の無い <br> は、ソースに書かれていた「<br>」として保存される）。
   */
  markSoftBreak() {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode;
    let prev = 3 === node.nodeType ? (0 === sel.anchorOffset ? node.previousSibling : null) : node.childNodes[sel.anchorOffset - 1];
    while (prev && 3 === prev.nodeType && '' === prev.data) prev = prev.previousSibling;
    if (prev && 'BR' === prev.nodeName && !prev.parentElement.closest('pre,.md-raw')) prev.dataset.soft = '1';
  }

  /** 入力された文字に応じて、見た目の書式に変換する（applyBlockRule・applyInlineRule）。 */
  applyInputRules() {
    if (this.applyBlockRule() || this.applyInlineRule() || this.linkifyEmailBeforeCaret(true)) this.changed();
  }

  /**
   * カーソルの直前に書いたメールアドレスを、mailto のリンク（data-bare。保存する時は書いたまま）にする。
   * 読み込んだ時と同じ表示にするため（markdown.js の renderInline 参照）、メールアドレスの後ろに空白・句読点等を
   * 打った時（a_typed）と、Enter を押す直前（!a_typed）に呼ぶ。コード・リンクの中では何もしない。
   * @param {boolean} a_typed メールアドレスの後ろに1文字打った直後か（その文字と、直前の「.」はリンクに含めない）
   * @returns {boolean} リンクにしたか
   */
  linkifyEmailBeforeCaret(a_typed) {
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || 3 !== sel.anchorNode.nodeType || !this.m_root.contains(sel.anchorNode)) {
      return false;
    }
    const node = sel.anchorNode;
    if (node.parentElement.closest('code,pre,.md-raw,a')) return false;
    const before = node.data.slice(0, sel.anchorOffset);
    // 後ろに打った文字（メールアドレスに使えない文字）と、その前の「.」（文の句点）は除く
    const tail = a_typed ? (before.match(/\.?[^A-Za-z0-9._%+@-]$/) || [null])[0] : '';
    if (null === tail) return false;
    const body = before.slice(0, before.length - tail.length);
    // メールアドレスの始まりの候補：直前がメールアドレスに使えない文字の所
    const m = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/);
    if (!m) return false;
    const start = body.length - m[0].length;
    if (RE_EMAIL_PREV_CHAR.test(body[start - 1] || '')) return false;
    const email = m[0].match(RE_BARE_EMAIL);
    if (!email || email[0].length !== m[0].length) return false;
    this.checkpoint('edit');
    const after = node.data.slice(sel.anchorOffset);
    node.data = body.slice(0, start);
    const link = document.createElement('a');
    link.setAttribute('href', `mailto:${email[0]}`);
    link.dataset.bare = '1';
    link.textContent = email[0];
    const rest = document.createTextNode(tail + after);
    node.after(link, rest);
    const range = document.createRange();
    range.setStart(rest, tail.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /**
   * 行頭の「# 」「- 」「1. 」「> 」「[ ] 」を、見出し・リスト・引用・チェックボックスにする（「[ ] 」は、箇条書きの
   * 項目の先頭と、表の見出しの行以外のセルの先頭）。
   * @returns {boolean} 変換したか
   */
  applyBlockRule() {
    const sel = getSelection();
    if (!sel.isCollapsed) return false;
    const block = this.currentTextBlock();
    if (!block) return false;
    const before = this.textBeforeCaret(block);
    const parent = block.parentNode;
    if ('P' === block.tagName && (parent === this.m_root || 'BLOCKQUOTE' === parent.tagName)) {
      let m;
      let replacement = null;
      let container = null;
      if ((m = before.match(/^(#{1,6}) $/))) {
        replacement = container = document.createElement(`h${m[1].length}`);
      } else if ((m = before.match(/^([-*+]) $/))) {
        replacement = document.createElement('ul');
        replacement.dataset.marker = m[1];
        container = replacement.appendChild(document.createElement('li'));
      } else if ((m = before.match(/^(\d{1,9})([.)]) $/))) {
        replacement = document.createElement('ol');
        replacement.dataset.marker = `1${m[2]}`;
        if ('1' !== m[1]) replacement.setAttribute('start', String(parseInt(m[1], 10)));
        container = replacement.appendChild(document.createElement('li'));
      } else if ('> ' === before && parent === this.m_root) {
        replacement = document.createElement('blockquote');
        container = replacement.appendChild(document.createElement('p'));
      }
      if (!replacement) return false;
      this.checkpoint('edit');
      this.deleteBeforeCaret(block);
      container.append(...block.childNodes);
      block.replaceWith(replacement);
      this.placeCaretAtStart(container);
      return true;
    }
    // 表のセルでは、後ろにスペースを打たなくても、セルの中身が「[ ]」「[x]」だけになった時（「]」を打った時）に
    // 変換する（セルの先頭の「[ ]」「[x]」は、後ろが空白でもセルの終わりでも、読み込むとチェックボックスになるため）
    const cellOnlyBox = 'TD' === block.tagName && /^\[[ xX]\]$/.test(before) &&
      before === block.textContent.replace(/[\u00a0\u3000]/g, ' ').replace(/\u200b/g, '').trimEnd();
    if (('LI' === block.tagName || 'TD' === block.tagName) && (/^\[([ xX]?)\] $/.test(before) || cellOnlyBox) &&
        !block.querySelector(':scope > input[type=checkbox]')) {
      this.checkpoint('edit');
      const checked = /x/i.test(before);
      this.deleteBeforeCaret(block);
      if ('LI' === block.tagName) block.classList.add('task');
      block.prepend(createCheckbox(checked));
      this.placeCaretAtStart(block);
      return true;
    }
    return false;
  }

  /**
   * 閉じ側の「**」「*」「~~」「==」「`」を打った時に、太字・斜体・取り消し線・ハイライト・コードにする。
   * @returns {boolean} 変換したか
   */
  applyInlineRule() {
    const sel = getSelection();
    if (!sel.isCollapsed || 3 !== sel.anchorNode.nodeType) return false;
    const node = sel.anchorNode;
    if (node.parentElement.closest('code,pre,.md-raw,a')) return false;
    const before = node.data.slice(0, sel.anchorOffset);
    const rules = [
      { re: /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, tag: 'strong', len: 2 },
      { re: /~~([^~\s](?:[^~]*[^~\s])?)~~$/, tag: 's', len: 2 },
      { re: /==([^=\s](?:[^=]*[^=\s])?)==$/, tag: 'mark', len: 2 },
      { re: /`([^`]+)`$/, tag: 'code', len: 1 },
      { re: /(?:^|[^*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, tag: 'em', len: 1 },
    ];
    for (const rule of rules) {
      const m = before.match(rule.re);
      if (!m) continue;
      this.checkpoint('edit');
      const inner = m[1];
      const start = before.length - inner.length - rule.len * 2;
      const after = node.data.slice(sel.anchorOffset);
      node.data = before.slice(0, start);
      const el = document.createElement(rule.tag);
      el.textContent = inner;
      // 書式の外側にカーソルを置くための目印（ゼロ幅の空白）。保存時には取り除く
      const tail = document.createTextNode(`\u200b${after}`);
      node.after(el, tail);
      const range = document.createRange();
      range.setStart(tail, 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
    return false;
  }

  /** Enter で新しい項目ができた時、チェックボックス付きの項目ならチェックボックスも付ける。 */
  afterNewParagraph() {
    const li = this.currentTextBlock();
    if (!li || 'LI' !== li.tagName || li.querySelector(':scope > input[type=checkbox]')) return;
    const prev = li.previousElementSibling;
    if (prev && prev.querySelector(':scope > input[type=checkbox]')) {
      li.classList.add('task');
      li.prepend(createCheckbox(false));
      this.placeCaretAtStart(li);
    }
  }

  /**
   * キーが押された時。書式のショートカット、元に戻す・やり直し、Enter・Tab・BackSpace の特別な動きを行う。
   * IME で変換中のキーは何もしない。
   * @param {KeyboardEvent} e
   */
  onKeyDown(e) {
    if (e.isComposing || 229 === e.keyCode) return;
    const key = e.key;
    // Ctrl+Shift+V：書式なしで貼り付け（貼り付け自体はブラウザの paste に任せ、onPaste で書式なしにする）
    this.m_pastePlain = e.ctrlKey && e.shiftKey && !e.altKey && 'v' === key.toLowerCase();
    // 文字の書式のショートカット（FORMATS 参照）
    const format = Object.keys(FORMATS).find((name) => FORMATS[name].match && FORMATS[name].match(e));
    if (format) {
      e.preventDefault();
      this.applyFormat(format);
      return;
    }
    if (e.ctrlKey && !e.altKey) {
      const k = key.toLowerCase();
      if ('z' === k && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if ('y' === k || ('z' === k && e.shiftKey)) { e.preventDefault(); this.redo(); return; }
      if ('Enter' === key) {
        // 表の中で Ctrl+Enter：下に行を挿入する
        const cell = this.currentTextBlock();
        if (cell && ('TD' === cell.tagName || 'TH' === cell.tagName)) {
          e.preventDefault();
          this.checkpoint('edit');
          this.insertRow(cell, true);
          this.changed();
        }
      }
      return;
    }
    const block = this.currentTextBlock();
    if (!block) return;
    // Enter の直前に書いたメールアドレスは、mailto のリンクにする（linkifyEmailBeforeCaret）
    if ('Enter' === key && !e.ctrlKey && !e.altKey && this.linkifyEmailBeforeCaret(false)) this.changed();
    if ('Enter' === key && !e.shiftKey) {
      if (this.onEnter(e, block)) this.changed();
    } else if ('Tab' === key) {
      e.preventDefault();
      if (this.onTab(block, e.shiftKey)) this.changed();
    } else if ('Backspace' === key) {
      if (this.onBackspace(e, block)) this.changed();
    }
  }

  /**
   * Enter キー。コードブロックの中の改行、リスト・引用から抜ける、「```」「---」「|a|b|」の変換を行う。
   * それ以外はブラウザ標準の改行（新しい段落・項目）に任せる。
   * @param {KeyboardEvent} e
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   * @returns {boolean} 文書を変更したか
   */
  onEnter(e, a_block) {
    const tag = a_block.tagName;
    const text = a_block.textContent.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    if ('PRE' === tag || a_block.classList.contains('md-raw')) {
      // コードブロックの中では、Enter は改行
      e.preventDefault();
      this.checkpoint('edit');
      this.insertTextAtCaret('\n');
      this.keepLastLineInCode(a_block);
      return true;
    }
    if ('TD' === tag || 'TH' === tag) {
      e.preventDefault(); // 表のセルの中では改行しない
      return false;
    }
    if ('LI' === tag && '' === this.ownText(a_block)) {
      // 空の項目で Enter：リストから抜ける（入れ子なら1段上に戻る）。チェックボックスの項目も同じ
      e.preventDefault();
      this.checkpoint('edit');
      const target = this.outdent(a_block);
      if (target) this.placeCaretAtStart(target);
      return true;
    }
    if ('P' !== tag || a_block.parentNode !== this.m_root) {
      if ('P' === tag && 'BLOCKQUOTE' === a_block.parentNode.tagName && '' === text && a_block === a_block.parentNode.lastElementChild) {
        // 引用の最後の空の行で Enter：引用から抜ける
        e.preventDefault();
        this.checkpoint('edit');
        const quote = a_block.parentNode;
        quote.after(a_block);
        if (0 === quote.children.length) quote.remove();
        this.placeCaretAtStart(a_block);
        return true;
      }
      return false;
    }
    // ここから先は、最上位の段落で Enter を押した時の変換（「```」「---」「|a|b|」）
    let m;
    if ((m = text.match(/^(`{3,}|~{3,})([^`]*)$/))) {
      // 「```言語名」＋ Enter：コードブロックにする
      e.preventDefault();
      this.checkpoint('edit');
      const pre = document.createElement('pre');
      pre.dataset.fence = m[1];
      pre.dataset.info = m[2].trim();
      const code = pre.appendChild(document.createElement('code'));
      code.textContent = '\n';
      a_block.replaceWith(pre);
      this.placeCaretAtStart(code);
      return true;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) {
      // 「---」＋ Enter：水平線にする
      e.preventDefault();
      this.checkpoint('edit');
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      a_block.replaceWith(document.createElement('hr'), p);
      this.placeCaretAtStart(p);
      return true;
    }
    if (/^\|(?:[^|]*\|)+\s*$/.test(text)) {
      // 「|見出し1|見出し2|」＋ Enter：表にする（見出しの行と、空の行を1行作る）
      e.preventDefault();
      this.checkpoint('edit');
      const cells = text.trim().slice(1, -1).split('|').map((c) => c.trim());
      const table = document.createElement('table');
      const head = table.createTHead().insertRow();
      for (const c of cells) {
        const th = document.createElement('th');
        th.textContent = c;
        if (!c) th.appendChild(document.createElement('br'));
        head.appendChild(th);
      }
      const row = table.createTBody().insertRow();
      for (let k = 0; k < cells.length; k++) row.insertCell().appendChild(document.createElement('br'));
      a_block.replaceWith(table);
      this.ensureTrailingParagraph();
      this.placeCaretAtStart(row.cells[0]);
      return true;
    }
    return false;
  }

  /**
   * リストの項目自身の文字（入れ子のリストの中は含めない）。画像だけの項目は空とみなさない。
   * @param {HTMLElement} a_li li 要素
   * @returns {string} 前後の空白・目印の文字を除いたもの
   */
  ownText(a_li) {
    let text = '';
    for (const n of a_li.childNodes) {
      if (1 === n.nodeType && ('UL' === n.tagName || 'OL' === n.tagName)) continue;
      text += n.textContent;
    }
    if (a_li.querySelector(':scope > img')) text += 'img';
    return text.replace(/[\u00a0\u200b]/g, '').trim();
  }

  /**
   * Tab キー。コードブロックではタブ文字、表ではセルの移動、リストでは字下げ（Shift+Tab は解除）。
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   * @param {boolean} a_shift Shift キーを押しているか
   * @returns {boolean} 文書を変更したか
   */
  onTab(a_block, a_shift) {
    if ('PRE' === a_block.tagName) {
      this.checkpoint('edit');
      if (!a_shift) this.insertTextAtCaret('\t');
      return true;
    }
    if ('TD' === a_block.tagName || 'TH' === a_block.tagName) return this.moveToCell(a_block, a_shift);
    if ('LI' !== a_block.tagName) return false;
    const offset = this.textBeforeCaret(a_block).length;
    this.checkpoint('edit');
    const target = a_shift ? this.outdent(a_block) : this.indent(a_block);
    if (target) this.restoreCaretInside(target, offset);
    return !!target;
  }

  /**
   * リストの項目を1段字下げする（直前の項目の中の入れ子のリストへ移す）。
   * @param {HTMLElement} a_li li 要素
   * @returns {HTMLElement|null} 移した項目。先頭の項目で字下げできない場合は null
   */
  indent(a_li) {
    const prev = a_li.previousElementSibling;
    if (!prev || 'LI' !== prev.tagName) return null;
    const list = a_li.parentElement;
    let sub = prev.lastElementChild;
    if (!sub || sub.tagName !== list.tagName) {
      sub = document.createElement(list.tagName.toLowerCase());
      if (list.dataset.marker) sub.dataset.marker = list.dataset.marker;
      prev.appendChild(sub);
    }
    sub.appendChild(a_li);
    return a_li;
  }

  /**
   * リストの項目の字下げを1段解除する。最上位の項目なら通常の段落に戻す。
   * @param {HTMLElement} a_li li 要素
   * @returns {HTMLElement} 移した項目、または段落に戻した場合はその段落
   */
  outdent(a_li) {
    const list = a_li.parentElement;
    const parentLi = list.parentElement;
    // 後ろの兄弟の項目は、この項目の入れ子として付いていく
    const following = [];
    for (let n = a_li.nextElementSibling; n; n = n.nextElementSibling) following.push(n);
    let sub = null;
    if (following.length) {
      sub = document.createElement(list.tagName.toLowerCase());
      if (list.dataset.marker) sub.dataset.marker = list.dataset.marker;
      sub.append(...following);
      if (parentLi && 'LI' === parentLi.tagName) a_li.appendChild(sub);
      else list.after(sub);
    }
    let result = a_li;
    if (parentLi && 'LI' === parentLi.tagName) {
      parentLi.after(a_li);
      // 空の項目に後ろの項目が付いてきた場合も、項目自身の行を残す（入れ子のリストと同じ行に並ばないように）
      ensureOwnLine(a_li);
    } else {
      const p = document.createElement('p');
      const nested = [];
      for (const child of [...a_li.childNodes]) {
        if (1 === child.nodeType && 'INPUT' === child.tagName) continue;
        if (1 === child.nodeType && ('UL' === child.tagName || 'OL' === child.tagName)) {
          nested.push(child);
          continue;
        }
        p.appendChild(child);
      }
      if (!p.firstChild) p.appendChild(document.createElement('br'));
      list.after(p);
      // 項目の入れ子のリストは、段落の後ろにリストとして残す（消さない）。後ろの項目のリストと同じ種類なら1つにする
      p.after(...nested);
      const last = nested[nested.length - 1];
      if (last && sub && last.nextElementSibling === sub && last.tagName === sub.tagName) {
        last.append(...sub.children);
        sub.remove();
      }
      a_li.remove();
      result = p;
    }
    if (0 === list.children.length) list.remove();
    return result;
  }

  /**
   * 字下げの前後で、カーソルを同じ項目の同じ文字の位置に戻す（項目が段落に変わった場合はその段落）。
   * @param {HTMLElement} a_target 項目（または段落）
   * @param {number} a_offset 項目の先頭から何文字目か（字下げの前に textBeforeCaret で求めたもの）
   */
  restoreCaretInside(a_target, a_offset) {
    const target = a_target;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      // リストの項目の場合、入れ子のリストの中の文字は数えない
      acceptNode: (n) => ('LI' !== target.tagName || n.parentElement.closest('li') === target
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let remain = a_offset;
    let node;
    while ((node = walker.nextNode())) {
      if (remain <= node.data.length) {
        const range = document.createRange();
        range.setStart(node, remain);
        range.collapse(true);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remain -= node.data.length;
    }
    this.placeCaretAtStart(target);
  }

  /**
   * BackSpace キー。行頭で押した時に、チェックボックス（箇条書きの項目・表のセル）・見出し・引用を解除する。
   * @param {KeyboardEvent} e
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   * @returns {boolean} 文書を変更したか
   */
  onBackspace(e, a_block) {
    const sel = getSelection();
    if (!sel.isCollapsed || '' !== this.textBeforeCaret(a_block)) return false;
    const box = 'LI' === a_block.tagName || 'TD' === a_block.tagName ? a_block.querySelector(':scope > input[type=checkbox]') : null;
    if (box) {
      // チェックボックスの項目・セルの先頭で BackSpace：チェックボックスを外して通常の項目・セルに戻す
      e.preventDefault();
      this.checkpoint('edit');
      const next = box.nextSibling;
      if (next && 3 === next.nodeType && next.data.startsWith('\u200b')) next.deleteData(0, 1);
      box.remove();
      a_block.classList.remove('task');
      this.placeCaretAtStart(a_block);
      return true;
    }
    if ('LI' === a_block.tagName && a_block.querySelector(':scope > ul, :scope > ol')) {
      // 入れ子のリストを持つ項目の先頭で BackSpace：項目の文字を前の行につなげ、入れ子の項目も前の項目の下へ移す
      // （Wordと同じ。ブラウザ標準では文字だけが移り、入れ子のリストを持つ空の項目が残るため）
      e.preventDefault();
      this.checkpoint('edit');
      this.mergeIntoPreviousItem(a_block);
      return true;
    }
    if (/^H[1-6]$/.test(a_block.tagName)) {
      // 見出しの先頭で BackSpace：通常の段落に戻す
      e.preventDefault();
      this.checkpoint('edit');
      const p = document.createElement('p');
      p.append(...a_block.childNodes);
      a_block.replaceWith(p);
      this.placeCaretAtStart(p);
      return true;
    }
    if ('P' === a_block.tagName && 'BLOCKQUOTE' === a_block.parentNode.tagName && a_block === a_block.parentNode.firstElementChild) {
      // 引用の先頭で BackSpace：引用を解除する
      e.preventDefault();
      this.checkpoint('edit');
      const quote = a_block.parentNode;
      quote.before(...quote.childNodes);
      quote.remove();
      this.placeCaretAtStart(a_block);
      return true;
    }
    return false;
  }

  /**
   * 入れ子のリストを持つ項目の先頭で BackSpace を押した時の処理（入れ子の空の項目で Enter・Shift+Tab を押してできた、
   * 入れ子のリストだけを持つ空の項目も同じ）。
   *  - 前に項目がある場合：項目の文字を、見た目で1つ上の行（前の項目の中の最後の項目）の末尾につなげ、入れ子の項目を
   *    前の項目の入れ子のリストの後ろへ移す。カーソルは、つなげた所に置く
   *  - 入れ子のリストの先頭の項目の場合：項目の文字を親の項目の文字の後ろにつなげ、入れ子の項目は1段上げて並べる
   *  - 最上位のリストの先頭の項目の場合：空の項目なら、入れ子の項目をこの項目の位置に1段上げて並べる。文字のある
   *    項目は、項目の記号を外して段落にする（Shift+Tab と同じ。入れ子の項目は段落の後ろにリストとして残る）
   * @param {HTMLLIElement} a_li 項目
   */
  mergeIntoPreviousItem(a_li) {
    const isList = (n) => 1 === n.nodeType && ('UL' === n.tagName || 'OL' === n.tagName);
    const nested = [...a_li.childNodes].filter(isList);
    const prev = a_li.previousElementSibling;
    const parentLi = a_li.parentElement.parentElement;
    let line = null;
    if (prev && 'LI' === prev.tagName) {
      // 見た目で1つ上の行：前の項目の中の、いちばん最後の項目
      line = prev;
      for (let sub = line.lastElementChild; sub && isList(sub) && sub.lastElementChild; sub = line.lastElementChild) {
        line = sub.lastElementChild;
      }
    } else if (parentLi && 'LI' === parentLi.tagName) {
      // 入れ子のリストの先頭の項目：見た目で1つ上の行は、親の項目
      line = parentLi;
    } else if ('' !== this.ownText(a_li)) {
      // 最上位のリストの先頭の項目：項目の記号を外して段落にする（Shift+Tab と同じ）
      const target = this.outdent(a_li);
      if (target) this.placeCaretAtStart(target);
      return;
    } else {
      // 最上位のリストの先頭の空の項目：入れ子の項目を、この項目の位置に1段上げて並べる
      const items = nested.flatMap((list) => [...list.children]);
      a_li.replaceWith(...items);
      if (items.length) this.placeCaretAtStart(items[0]);
      return;
    }
    let length = 0;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('li') === line ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n; (n = walker.nextNode());) length += n.data.length;
    // 項目の文字（入れ子のリスト・チェックボックス以外）を、その行の文字の後ろにつなげる
    const content = [...a_li.childNodes].filter((n) => !isList(n) && !(1 === n.nodeType && 'INPUT' === n.tagName));
    const anchor = [...line.childNodes].find(isList) || null;
    const lastOwn = anchor ? anchor.previousSibling : line.lastChild;
    if (lastOwn && 'BR' === lastOwn.nodeName && !lastOwn.dataset.soft) lastOwn.remove();
    for (const n of content) line.insertBefore(n, anchor);
    const tail = anchor ? anchor.previousSibling : line.lastChild;
    if (tail && 'BR' === tail.nodeName && !tail.dataset.soft) tail.remove();
    if (line === parentLi) {
      // 親の項目につなげた場合：入れ子の項目は、この項目の位置に1段上げて並べる
      a_li.replaceWith(...nested.flatMap((list) => [...list.children]));
    } else {
      // 入れ子の項目を、前の項目の入れ子のリストの後ろへ移す
      for (const list of nested) {
        const last = prev.lastElementChild;
        if (last && last.tagName === list.tagName) last.append(...list.children);
        else prev.appendChild(list);
      }
      a_li.remove();
    }
    this.restoreCaretInside(line, length);
  }

  /**
   * クリック。リンクを開く、チェックボックスの切り替えを記録する。
   * @param {MouseEvent} e
   */
  onClick(e) {
    // リンクをクリックしたら開く（Ctrl は不要。Ctrl+クリックでも開く）。ドラッグで文字を選択した時、
    // ダブルクリック（単語の選択）、Shift+クリック（選択範囲を広げる）では開かない。
    // リンクの文字を編集する時は、矢印キーでカーソルを移動する
    const link = e.target.closest && e.target.closest('a[href]');
    const down = this.m_mouseDown;
    const notDragged = down && Math.abs(e.clientX - down.x) < 5 && Math.abs(e.clientY - down.y) < 5;
    if (link && this.m_root.contains(link) && !e.shiftKey && 1 === e.detail && notDragged) {
      e.preventDefault();
      // 文中にそのまま書いたメールアドレスのリンク（data-bare）は、書き直されていても今の文字で開く
      this.m_handlers.onOpenLink(link.dataset.bare ? `mailto:${link.textContent.trim()}` : link.getAttribute('href'));
      return;
    }
    const box = e.target;
    if ('INPUT' === box.tagName && 'checkbox' === box.type) {
      // チェックボックスの切り替え（変更として記録されるよう、属性にも反映する）
      this.checkpoint('edit');
      box.toggleAttribute('checked', box.checked);
      this.changed();
    }
  }

  // ===== 右クリックのメニュー（切り取り・コピー・貼り付け、文字の書式、見出し・表の挿入、表の操作、ソースモード） =====

  /**
   * 右クリック。ブラウザ標準のメニューの代わりに、自前のメニュー（showMenu）を出す。
   * 表のセルの上では表の操作の項目を、それ以外では「見出し」「表を挿入…」の項目を加える（mde と同じ）。
   * @param {MouseEvent} e
   */
  onContextMenu(e) {
    if (!this.m_root.contains(e.target)) return;
    e.preventDefault();
    const sel = getSelection();
    const hasSelection = sel.rangeCount > 0 && !sel.isCollapsed && this.m_root.contains(sel.anchorNode);
    const items = [];
    if ('IMG' === e.target.tagName) {
      const src = imageSource(e.target);
      items.push({ label: '画像を開く', run: () => this.m_handlers.onOpenImage(src) }, null);
    }
    items.push(
      { label: '切り取り', key: 'Ctrl+X', disabled: !hasSelection, run: () => document.execCommand('cut') },
      { label: 'コピー', key: 'Ctrl+C', disabled: !hasSelection, run: () => document.execCommand('copy') },
      { label: 'Excel用にコピー', disabled: !hasSelection, run: () => this.copyForExcel() },
      { label: '貼り付け', key: 'Ctrl+V', run: () => this.pasteFromClipboard(false) },
      { label: '書式なしで貼り付け', key: 'Ctrl+Shift+V', run: () => this.pasteFromClipboard(true) },
      null,
    );
    for (const name of Object.keys(FORMATS)) {
      const state = this.formatState(name);
      items.push({ label: FORMATS[name].label, key: FORMATS[name].key, checked: state.active, disabled: !state.enabled,
        run: () => this.applyFormat(name) });
    }
    // リンクにする（mde と同じ。URL を入力するダイアログはホスト側で出す）。選んだ範囲は、URL が届くまで覚えておく
    const linkRange = this.linkableRange();
    items.push({ label: 'リンクにする…', disabled: !linkRange, run: () => this.m_handlers.onMakeLink(linkRange) });
    const cell = e.target.closest && e.target.closest('td,th');
    if (!cell || !this.m_root.contains(cell)) {
      // 見出し・表を挿入（mde と同じ。表のセルの上では出さない）。対象は右クリックした段落
      const block = this.contextBlock(e.target);
      const heading = this.headingTarget(block);
      items.push(null);
      if (heading) {
        const level = /^H[1-6]$/.test(heading.tagName) ? Number(heading.tagName[1]) : 0;
        items.push({
          label: level ? `見出し${level}` : '見出し',
          submenu: [0, 1, 2, 3, 4, 5, 6].map((n) => ({
            label: n ? `${'#'.repeat(n)} 見出し${n}` : '本文（見出しなし）',
            checked: n === level,
            run: () => this.setHeadingLevel(heading, n),
          })),
        });
      }
      items.push({ label: '表を挿入…', run: () => this.m_handlers.onInsertTable(this.topLevelBlock(block)) });
    }
    if (cell && this.m_root.contains(cell)) {
      const isHeader = 'TH' === cell.tagName;
      const table = (a_run) => () => {
        this.checkpoint('edit');
        a_run();
        this.changed();
      };
      items.push(
        null,
        { label: '上に行を挿入', disabled: isHeader, run: table(() => this.insertRow(cell, false)) },
        { label: '下に行を挿入', key: 'Ctrl+Enter', run: table(() => this.insertRow(cell, true)) },
        { label: '行を削除', disabled: isHeader, run: table(() => this.deleteRow(cell)) },
        null,
        { label: '左に列を挿入', run: table(() => this.insertColumn(cell, false)) },
        { label: '右に列を挿入', run: table(() => this.insertColumn(cell, true)) },
        { label: '列を削除', run: table(() => this.deleteColumn(cell)) },
        null,
        { label: '表をコピー', run: () => writeClipboard(buildTableCopy(cell.closest('table'), this.m_handlers.imageFileUrl)) },
        { label: '表を削除', run: table(() => this.deleteTable(cell)) },
      );
    }
    items.push(null, { label: 'すべて選択', key: 'Ctrl+A', run: () => this.selectAll() });
    items.push(null,
      { label: 'ページトップに戻る', run: () => this.m_handlers.onPageTop() },
      { label: 'ソースモードに切り替え', run: () => this.m_handlers.onToggleSource() });
    showMenu(e.clientX, e.clientY, items, (a_item) => a_item.run());
  }

  /**
   * 「リンクにする…」を使える選択範囲。1つの段落（見出し・リストの項目・表のセル等）の中で文字を選んでいて、
   * コードブロック・インラインコード・解釈できない部分・リンクの中でなく、選んだ範囲にリンクを含まない時だけ。
   * @returns {Range|null} 選択範囲の複製（使えない時は null）
   */
  linkableRange() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !this.m_root.contains(sel.anchorNode) || !this.m_root.contains(sel.focusNode)) {
      return null;
    }
    const elementOf = (a_node) => (3 === a_node.nodeType ? a_node.parentElement : a_node);
    const anchor = elementOf(sel.anchorNode);
    const focus = elementOf(sel.focusNode);
    const block = anchor.closest(TEXT_BLOCK_SELECTOR);
    if (!block || block !== focus.closest(TEXT_BLOCK_SELECTOR)) return null;
    if (anchor.closest('pre,code,.md-raw,a') || focus.closest('pre,code,.md-raw,a')) return null;
    const range = sel.getRangeAt(0);
    if (range.cloneContents().querySelector('a')) return null;
    return range.cloneRange();
  }

  /**
   * 右クリックのメニューの「リンクにする…」：選んでいた文字をリンクにする（mde と同じ）。カーソルはリンクの後ろに置く。
   * @param {Range} a_range linkableRange で覚えておいた選択範囲
   * @param {string} a_url リンク先の URL
   */
  makeLink(a_range, a_url) {
    if (!a_range || a_range.collapsed || !a_url || !this.m_root.contains(a_range.commonAncestorContainer)) return;
    this.checkpoint('edit');
    const link = document.createElement('a');
    link.setAttribute('href', a_url);
    link.appendChild(a_range.extractContents());
    a_range.insertNode(link);
    this.focus();
    const range = document.createRange();
    range.setStartAfter(link);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this.changed();
  }

  /**
   * 右クリックした場所の、文字を書く単位の要素（段落・見出し等）。段落の外（余白等）なら、カーソルのある要素。
   * @param {EventTarget} a_target 右クリックした要素
   * @returns {HTMLElement|null}
   */
  contextBlock(a_target) {
    const el = a_target && 1 === a_target.nodeType ? a_target : a_target && a_target.parentElement;
    const block = el && el.closest && el.closest(TEXT_BLOCK_SELECTOR);
    return block && this.m_root.contains(block) ? block : this.currentTextBlock();
  }

  /**
   * 見出しのレベルを変えられる要素か（最上位、または引用の中の、段落・見出し。リストの項目・コードブロック等は変えない）。
   * @param {HTMLElement|null} a_block 文字を書く単位の要素
   * @returns {HTMLElement|null} 変えられるなら a_block、変えられないなら null
   */
  headingTarget(a_block) {
    if (!a_block || !/^(P|H[1-6])$/.test(a_block.tagName)) return null;
    const parent = a_block.parentNode;
    return parent === this.m_root || 'BLOCKQUOTE' === parent.tagName ? a_block : null;
  }

  /**
   * a_block を含む、最上位のブロック（表を挿入する時に、その後ろに置くため）。
   * @param {HTMLElement|null} a_block 文字を書く単位の要素
   * @returns {HTMLElement|null}
   */
  topLevelBlock(a_block) {
    let block = a_block;
    while (block && block.parentNode !== this.m_root) block = block.parentNode;
    return block || null;
  }

  /**
   * 右クリックのメニューの「見出し」：段落・見出しの見出しのレベルを変える（0 は本文。mde と同じ）。
   * カーソルがその要素の中にあれば、同じ文字の位置に戻す。
   * @param {HTMLElement} a_block 段落・見出し（headingTarget）
   * @param {number} a_level 見出しのレベル（0〜6）
   */
  setHeadingLevel(a_block, a_level) {
    const tag = a_level ? `H${a_level}` : 'P';
    if (!a_block.isConnected || a_block.tagName === tag) return;
    this.checkpoint('edit');
    const sel = getSelection();
    let offset = null;
    if (sel.rangeCount && a_block.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.setStart(a_block, 0);
      range.setEnd(sel.anchorNode, sel.anchorOffset);
      offset = range.toString().length;
    }
    const el = document.createElement(tag);
    el.append(...a_block.childNodes);
    a_block.replaceWith(el);
    if (null !== offset) this.restoreCaretInside(el, offset);
    else this.placeCaretAtStart(el);
    this.changed();
  }

  /**
   * 右クリックのメニューの「表を挿入…」：行数（見出しの行を含む）・列数を指定した空の表を挿入する（mde と同じ）。
   * 右クリックした段落（を含む最上位のブロック）の後ろに置く。その段落が空なら、段落を表に置き換える。
   * 表の後ろに段落が無ければ、続けて書けるよう空の段落も置く。カーソルは見出しの行の最初のセルに置く。
   * @param {HTMLElement|null} a_anchor 右クリックした段落を含む最上位のブロック（無い・消えていれば文書の最後に置く）
   * @param {number} a_rows 行数（見出しの行を含む）
   * @param {number} a_cols 列数
   */
  insertTable(a_anchor, a_rows, a_cols) {
    this.checkpoint('edit');
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (let c = 0; c < a_cols; c++) head.appendChild(this.newCell(table, -1, true));
    if (a_rows > 1) {
      const body = table.createTBody();
      for (let r = 1; r < a_rows; r++) {
        const tr = body.insertRow();
        for (let c = 0; c < a_cols; c++) tr.appendChild(this.newCell(table, -1, false));
      }
    }
    const anchor = a_anchor && a_anchor.parentNode === this.m_root ? a_anchor : null;
    const isEmptyParagraph = (a_el) => 'P' === a_el.tagName && '' === a_el.textContent.replace(/\u200b/g, '').trim()
      && !a_el.querySelector('img');
    if (anchor && isEmptyParagraph(anchor)) anchor.replaceWith(table);
    else if (anchor) anchor.after(table);
    else this.m_root.appendChild(table);
    const next = table.nextElementSibling;
    if (!next || 'P' !== next.tagName) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      table.after(p);
    }
    this.focus();
    this.placeCaretAtStart(head.cells[0]);
    this.changed();
  }

  /** 文書全体を選択する。 */
  selectAll() {
    const range = document.createRange();
    range.selectNodeContents(this.m_root);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ===== 文字の書式（太字・斜体・下線・取り消し線・インラインコード・ハイライト） =====

  /**
   * 選択範囲（カーソル位置）の書式の状態。
   * @param {string} a_name 書式の名前（FORMATS のキー：bold・italic・underline・strike・code・mark）
   * @returns {{enabled:boolean, active:boolean}} enabled：その書式を使えるか、active：既にその書式か
   */
  formatState(a_name) {
    const sel = getSelection();
    if (!sel.rangeCount || !this.m_root.contains(sel.anchorNode) || !this.m_root.contains(sel.focusNode)) {
      return { enabled: false, active: false };
    }
    const elementOf = (a_node) => (3 === a_node.nodeType ? a_node.parentElement : a_node);
    const anchor = elementOf(sel.anchorNode);
    const focus = elementOf(sel.focusNode);
    // コードブロック・解釈できない部分（md-raw）の中は書式を付けられない（保存時に失われるため）
    if (anchor.closest('pre,.md-raw') || focus.closest('pre,.md-raw')) return { enabled: false, active: false };
    const format = FORMATS[a_name];
    if (format.command) {
      // インラインコードの中の文字は太字等にできない（Markdown ではコードの中の書式は書けないため）
      if (anchor.closest('code') || focus.closest('code')) return { enabled: false, active: false };
      return { enabled: true, active: document.queryCommandState(format.command) };
    }
    const own = anchor.closest(format.tag);
    if (own && this.m_root.contains(own)) return { enabled: true, active: true };
    if (anchor.closest('code') || focus.closest('code')) return { enabled: false, active: false };
    // 選択範囲を囲む場合：1つの段落（セル等）の中だけ。何も選択していない時は使えない
    const enabled = !sel.isCollapsed && this.currentTextBlock() === (focus.closest(TEXT_BLOCK_SELECTOR) || null);
    return { enabled, active: false };
  }

  /**
   * 書式を付ける・外す（既にその書式なら外す）。使えない場所（コードブロックの中等）では何もしない。
   * @param {string} a_name 書式の名前（FORMATS のキー）
   */
  applyFormat(a_name) {
    const state = this.formatState(a_name);
    if (!state.enabled) return;
    this.checkpoint('edit');
    const format = FORMATS[a_name];
    if (format.command) {
      // 太字・斜体・下線・取り消し線はブラウザ標準の書式の切り替えを使う（選択範囲の一部だけが太字の場合等も
      // 正しく扱える）。何も選択していない時は、この後に打つ文字がその書式になる
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(format.command);
    } else if (state.active) {
      this.unwrapFormat(format.tag);
    } else {
      this.wrapFormat(format.tag);
    }
    this.changed();
  }

  /**
   * 選択範囲を a_tag（code・mark）で囲み、囲んだ中身を選択する。インラインコードの中は文字だけにする。
   * @param {string} a_tag 要素名（'code'・'mark'）
   */
  wrapFormat(a_tag) {
    const sel = getSelection();
    const range = sel.getRangeAt(0);
    const el = document.createElement(a_tag);
    if ('code' === a_tag) {
      el.textContent = range.toString().replace(/\u200b/g, '');
      range.deleteContents();
    } else {
      el.appendChild(range.extractContents());
      // 選択範囲に同じ書式が含まれていた場合は、入れ子にしない
      for (const inner of [...el.querySelectorAll(a_tag)]) inner.replaceWith(...inner.childNodes);
    }
    range.insertNode(el);
    // 空になった前後の書式の要素（<b></b> 等）は取り除く
    for (const sibling of [el.previousSibling, el.nextSibling]) {
      if (sibling && 1 === sibling.nodeType && '' === sibling.textContent && !sibling.querySelector('img,br')) sibling.remove();
    }
    const after = document.createRange();
    after.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(after);
  }

  /**
   * カーソル（選択範囲）のある a_tag（code・mark）の書式を外し、外した中身を選択する。
   * @param {string} a_tag 要素名（'code'・'mark'）
   */
  unwrapFormat(a_tag) {
    const sel = getSelection();
    const node = sel.anchorNode;
    const el = (3 === node.nodeType ? node.parentElement : node).closest(a_tag);
    if (!el) return;
    const first = el.firstChild;
    const last = el.lastChild;
    el.replaceWith(...el.childNodes);
    if (first && last) {
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * 新しいセルを作る（見出しの行なら th、それ以外は td。列の揃え方は見出しのセルに合わせる）。
   * @param {HTMLTableElement} a_table 表
   * @param {number} a_column 列の番号（揃え方を合わせる見出しのセル。新しい列の場合は -1）
   * @param {boolean} a_header 見出しの行のセルか
   * @returns {HTMLTableCellElement} 空のセル（カーソルを置けるよう <br> 入り）
   */
  newCell(a_table, a_column, a_header) {
    const cell = document.createElement(a_header ? 'th' : 'td');
    const head = a_table.rows[0] && a_table.rows[0].cells[a_column];
    const align = head ? head.dataset.align : '';
    if (align) {
      cell.dataset.align = align;
      cell.style.textAlign = align;
    }
    cell.appendChild(document.createElement('br'));
    return cell;
  }

  /**
   * 行を挿入し、新しい行の同じ列のセルにカーソルを置く。見出しの行の下に挿入した場合は、本文の先頭の行になる。
   * @param {HTMLTableCellElement} a_cell 今のセル
   * @param {boolean} a_below 下に挿入するか（false は上）
   */
  insertRow(a_cell, a_below) {
    const table = a_cell.closest('table');
    const row = a_cell.parentElement;
    const columns = table.rows[0].cells.length;
    const tr = document.createElement('tr');
    for (let k = 0; k < columns; k++) tr.appendChild(this.newCell(table, k, false));
    if ('THEAD' === row.parentElement.tagName) {
      const body = table.tBodies[0] || table.createTBody();
      body.prepend(tr);
    } else if (a_below) {
      row.after(tr);
    } else {
      row.before(tr);
    }
    this.placeCaretAtStart(tr.cells[Math.min(a_cell.cellIndex, columns - 1)]);
  }

  /**
   * 行を削除し、隣の行にカーソルを移す。見出しの行は削除しない（表を削除で消す）。
   * @param {HTMLTableCellElement} a_cell 削除する行のセル
   */
  deleteRow(a_cell) {
    const row = a_cell.parentElement;
    if ('THEAD' === row.parentElement.tagName) return; // 見出しの行は削除しない（表を削除で消す）
    const next = row.nextElementSibling || row.previousElementSibling || row.closest('table').rows[0];
    const column = a_cell.cellIndex;
    row.remove();
    if (next) this.placeCaretAtStart(next.cells[Math.min(column, next.cells.length - 1)]);
  }

  /**
   * 列を挿入し、新しい列のセルにカーソルを置く。
   * @param {HTMLTableCellElement} a_cell 今のセル
   * @param {boolean} a_right 右に挿入するか（false は左）
   */
  insertColumn(a_cell, a_right) {
    const table = a_cell.closest('table');
    const index = a_cell.cellIndex + (a_right ? 1 : 0);
    for (const row of table.rows) {
      const isHeader = 'THEAD' === row.parentElement.tagName;
      const cell = this.newCell(table, -1, isHeader);
      row.insertBefore(cell, row.cells[index] || null);
    }
    this.placeCaretAtStart(a_cell.parentElement.cells[index]);
  }

  /**
   * 列を削除する。最後の1列なら表ごと削除する。
   * @param {HTMLTableCellElement} a_cell 削除する列のセル
   */
  deleteColumn(a_cell) {
    const table = a_cell.closest('table');
    const index = a_cell.cellIndex;
    if (1 >= table.rows[0].cells.length) {
      this.deleteTable(a_cell); // 最後の1列なら表ごと削除
      return;
    }
    const row = a_cell.parentElement;
    for (const r of [...table.rows]) if (r.cells[index]) r.cells[index].remove();
    this.placeCaretAtStart(row.cells[Math.min(index, row.cells.length - 1)]);
  }

  /**
   * 表を削除し、代わりに空の段落を置く。
   * @param {HTMLTableCellElement} a_cell 表の中のセル
   */
  deleteTable(a_cell) {
    const table = a_cell.closest('table');
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    table.replaceWith(p);
    this.placeCaretAtStart(p);
  }

  /**
   * 貼り付け（Ctrl+V・Ctrl+Shift+V）。ブラウザ標準の書式付きの貼り付けの代わりに pasteContent で貼る。
   * @param {ClipboardEvent} e
   */
  onPaste(e) {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const plain = this.m_pastePlain;
    this.m_pastePlain = false;
    const image = [...data.files].find((f) => f.type.startsWith('image/'));
    this.pasteData({
      text: data.getData('text/plain') || '',
      html: data.getData('text/html') || '',
      markdown: data.getData(MARKDOWN_MIME) || null,
      image: image || null,
    }, plain);
  }

  /**
   * クリップボードの内容を、形式に合わせて貼り付ける。
   *  - mdew でコピーした内容：一緒にコピーした Markdown を、書式にして貼る（見出し・表等もそのまま）
   *  - Excel 等の表（表だけの HTML・タブ区切りの文字）：Markdown の表にして貼る（mde と同じ。表のセルの中と、
   *    コードブロックの中では文字のまま）
   *  - 他のアプリの書式付きの内容（Claude 等のチャット・Web ページ・Word 等の HTML）：見出し・リスト・太字・
   *    リンク等を Markdown にして貼る（clipboard.js の htmlToMarkdown）。書式が無い場合は文字を貼る
   *  - それ以外：pasteContent（文字は Markdown として読む。画像だけならホストに保存を依頼する）
   * @param {{text:string, html:string, markdown:string|null, image:File|null}} a_data クリップボードの内容
   * @param {boolean} a_plain 書式なしで貼り付けるか
   */
  pasteData(a_data, a_plain) {
    const text = a_data.text || '';
    const block = this.currentTextBlock();
    const tag = block ? block.tagName : '';
    const inCode = block && ('PRE' === tag || block.classList.contains('md-raw'));
    const inCell = 'TD' === tag || 'TH' === tag;
    if (a_plain || inCode || (a_data.image && '' === text.trim())) {
      this.pasteContent(text, a_data.image, a_plain);
      return;
    }
    const markdown = a_data.markdown ?? lastCopiedMarkdown(text);
    if (null != markdown && '' !== markdown) {
      this.pasteContent(markdown, null, false);
      return;
    }
    const htmlRows = tableFromHtml(a_data.html);
    // 書式付きの HTML（見出し・リスト等のタグがある）なら、文字（タブ区切り）より HTML を使う
    const opts = { bullet: this.m_bullet };
    const converted = htmlRows ? null : htmlToMarkdown(a_data.html, opts);
    const useHtml = !!converted && '' !== converted.markdown && (converted.rich || '' === text.trim());
    const rows = htmlRows || (inCell || useHtml ? null : tableFromTsv(text));
    if (rows && block) {
      const srcs = imageSourcesInRows(rows);
      if (srcs.length) {
        // Excel の範囲の中の画像：ホストに一時フォルダへコピーしてもらってから貼る（貼る位置は今のカーソル位置）
        this.importImagesThen(srcs, (a_urls) => this.pasteTable(rows, text, a_urls, inCell));
        return;
      }
      if (!inCell) {
        this.pasteTable(rows, text, null, false);
        return;
      }
    }
    if (useHtml && block) {
      // 表のセルの中は、1つの段落になる場合だけ（リスト等は文字のまま貼る）
      const blocks = inCell ? parseBlocks(converted.markdown) : null;
      if (!inCell || (1 === blocks.length && 'paragraph' === blocks[0].type)) {
        if (converted.images.length) {
          // Word 等の画像（PC の中の一時ファイル）：ホストに一時フォルダへコピーしてもらってから貼る
          this.importImagesThen(converted.images, (a_urls) =>
            this.pasteContent(htmlToMarkdown(a_data.html, { ...opts, urls: a_urls }).markdown, null, false, text));
        } else {
          this.pasteContent(converted.markdown, null, false, text);
        }
        return;
      }
    }
    this.pasteContent(text, a_data.image, a_plain);
  }

  /**
   * 他のアプリの画像（PC の中のファイル）を、ホストに一時フォルダへコピーしてもらってから、a_paste を呼ぶ。
   * 貼る位置は、今のカーソル位置（コピーし終えるまでの間にカーソルが動いても戻す）。
   * @param {string[]} a_srcs 画像の参照先（file:///…）
   * @param {(urls: Map<string,string>) => void} a_paste 貼り付ける関数（参照先 → 貼り付けた画像の URL を受け取る）
   */
  importImagesThen(a_srcs, a_paste) {
    const sel = getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    this.m_handlers.importImages(a_srcs).then((a_urls) => {
      const urls = new Map(a_srcs.map((src, k) => [src, a_urls[k]]).filter(([, u]) => u));
      if (range && this.m_root.contains(range.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      a_paste(urls);
    });
  }

  /**
   * Excel 等の表を、カーソル位置に Markdown の表として貼る（1つのセルだけの場合と、表のセルの中に貼る場合は、
   * セルの文字と画像を段落の中に貼る）。
   * @param {({text:string, images?:object[]}|string)[][]} a_rows セル（clipboard.js の tableFromHtml・tableFromTsv）
   * @param {string} a_text クリップボードの文字（表を置けない場所では、これを文字のまま貼る）
   * @param {Map<string,string>|null} a_urls 画像の参照先 → 貼り付けた画像の URL
   * @param {boolean} a_inCell カーソルが表のセルの中か
   */
  pasteTable(a_rows, a_text, a_urls, a_inCell) {
    const block = this.currentTextBlock();
    if (!block) return;
    this.checkpoint('edit');
    const single = 1 === a_rows.length && 1 === a_rows[0].length;
    if (single || a_inCell) {
      // 1つのセル・表のセルの中：セルの内容を並べて、段落（セル）の中に貼る
      const inline = a_rows.map((r) => r.map((c) => cellMarkdown(c, a_urls)).filter(Boolean).join(' ')).join(a_inCell ? ' ' : '\n');
      this.insertInlineMarkdown(a_inCell ? inline.replace(/\n/g, '<br>') : inline);
    } else if (!this.pasteMarkdown(rowsToMarkdownTable(a_rows, a_urls), block)) {
      // 引用の中等、表を置けない場所では文字のまま貼る
      a_text.replace(/\r\n?/g, '\n').split('\n').forEach((line, k) => {
        if (k > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
    }
    this.changed();
  }

  /**
   * コピー・切り取り（Ctrl+C・Ctrl+X・右クリックのメニュー）。文字に加えて、他のアプリ向けの HTML と、
   * mdew どうしで書式を保つ Markdown もコピーする（clipboard.js の buildCopyData）。
   * @param {ClipboardEvent} e
   * @param {boolean} a_cut 切り取りか（コピーした後に、選んだ範囲を消す）
   */
  onCopy(e, a_cut) {
    const sel = getSelection();
    if (!e.clipboardData || !sel.rangeCount || sel.isCollapsed || !this.m_root.contains(sel.anchorNode)) return;
    e.preventDefault();
    setClipboardData(e.clipboardData, buildCopyData(sel, this.m_root, { bullet: this.m_bullet }, this.m_handlers.imageFileUrl));
    if (a_cut) {
      this.checkpoint('edit');
      document.execCommand('delete');
      this.changed();
    }
  }

  /**
   * 右クリックの「Excel用にコピー」（mde と同じ。clipboard.js の buildExcelCopy）。段落の中の一部だけを
   * 選んでいる場合は、通常のコピーをする。
   */
  copyForExcel() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const data = buildExcelCopy(sel.getRangeAt(0), this.m_root, this.m_handlers.imageFileUrl);
    if (data) writeClipboard(data);
    else document.execCommand('copy');
  }

  /**
   * 右クリックのメニューの「貼り付け」「書式なしで貼り付け」。クリップボードを読み取って、Ctrl+V と同じように
   * 貼り付ける。読み取りの許可はホストが与える（Program.cs の PermissionRequested）。
   * @param {boolean} a_plain 書式なしで貼り付けるか（Markdown の記号を書式に変換しない）
   * @returns {Promise<void>}
   */
  async pasteFromClipboard(a_plain) {
    let text = '';
    let html = '';
    let image = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        const type = item.types.find((t) => t.startsWith('image/'));
        if (!image && type) image = new File([await item.getType(type)], 'image.png', { type });
      }
    } catch (err) {
      this.m_handlers.onError('クリップボードを読み取れませんでした。Ctrl+V で貼り付けてください。');
      return;
    }
    this.focus();
    this.pasteData({ text, html, markdown: null, image }, a_plain);
  }

  /**
   * クリップボードの内容を貼り付ける。
   *  - 画像だけの場合：ホストに保存を依頼する（Excel のセルのように文字も入っている場合は文字を貼る）
   *  - 文字：Markdown として読み、見出し・リスト・太字等の書式にして貼る（pasteMarkdown）。
   *    コードブロックの中ではそのまま、表のセルの中では1行にして貼る。
   *  - 書式なしで貼り付け（a_plain）の場合と、書式にできない場所（引用の中に複数の段落を貼る等）では、
   *    文字のまま行ごとに段落にして貼る
   * @param {string} a_text クリップボードの文字（無ければ ''）
   * @param {File|null} a_image クリップボードの画像（無ければ null）
   * @param {boolean} [a_plain] 書式なしで貼り付けるか
   * @param {string} [a_fallback] 書式にできない場所で、a_text の代わりに文字のまま貼る文字（HTML から変換した
   *   Markdown を貼る時の、クリップボードの文字。Markdown の記号がそのまま入らないように）
   */
  pasteContent(a_text, a_image, a_plain, a_fallback) {
    if (a_image && '' === a_text.trim()) {
      const sel = getSelection();
      this.m_pasteRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      this.m_handlers.onPasteImage(a_image);
      return;
    }
    if (!a_text) return;
    this.checkpoint('edit');
    const text = a_text.replace(/\r\n?/g, '\n');
    const block = this.currentTextBlock();
    const tag = block ? block.tagName : '';
    if (block && ('PRE' === tag || block.classList.contains('md-raw'))) {
      // コードブロックの中は文字のまま（ブラウザの insertText は改行でコードブロックを分割してしまうため直接書き込む）
      this.insertTextAtCaret(text);
      if (text.endsWith('\n')) this.keepLastLineInCode(block);
    } else if ('TD' === tag || 'TH' === tag) {
      // 表のセルの中は改行できないため、1行にする
      const line = text.replace(/\n+/g, ' ');
      if (a_plain) document.execCommand('insertText', false, line);
      else this.insertInlineMarkdown(line);
    } else if (a_plain || !block || !this.pasteMarkdown(text, block)) {
      const lines = a_plain || null == a_fallback ? text : a_fallback.replace(/\r\n?/g, '\n');
      lines.split('\n').forEach((line, k) => {
        if (k > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
    }
    this.changed();
  }

  /**
   * Markdown の文字を書式にして、カーソル位置に貼り付ける。
   *  - 1つの段落だけの場合：今の段落（見出し・項目等）の中に、太字・リンク等の書式にして挿入する
   *  - 複数のブロック（見出し・リスト・表・コードブロック等）の場合：今の段落をカーソル位置で分けて、
   *    その間にブロックを入れる。貼る内容の最初・最後が段落なら、分けた前後の文字とつなげる
   *  - リストの項目の中にリストだけを貼る場合：今の項目の後ろに項目として加える
   * @param {string} a_text 貼り付ける文字（改行は LF）
   * @param {HTMLElement} a_block カーソルのある、文字を書く単位の要素
   * @returns {boolean} 貼り付けたか（この場所では書式にできない場合は false。呼び出し側で文字のまま貼る）
   */
  pasteMarkdown(a_text, a_block) {
    const blocks = parseBlocks(a_text);
    if (0 === blocks.length) return false;
    const tag = a_block.tagName;
    const isHeading = /^H[1-6]$/.test(tag);
    if (1 === blocks.length && 'paragraph' === blocks[0].type) {
      // 行頭の空白も残すよう、読み取った段落ではなく貼り付けた文字（前後の空行を除いたもの）を使う。
      // 見出しの中は改行できないため、1行にする
      const inline = a_text.replace(/^\n+|\n+$/g, '');
      this.insertInlineMarkdown(isHeading ? inline.replace(/\n/g, ' ') : inline);
      return true;
    }
    const sel = getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);

    if ('LI' === tag) {
      // リストの項目の中にリストを貼る：項目として今の項目の後ろに加える（今の項目が空なら置き換える）
      if (1 !== blocks.length || 'list' !== blocks[0].type) return false;
      const items = [...htmlToNodes(renderBlock(blocks[0]))[0].children];
      range.deleteContents();
      a_block.after(...items);
      if ('' === this.ownText(a_block) && !a_block.querySelector('ul,ol')) a_block.remove();
      placeCaretAtEnd(items[items.length - 1]);
      return true;
    }
    // ここから先は、最上位の段落・見出しの中に貼る場合だけ（引用の中等は文字のまま貼る）
    if (!('P' === tag || isHeading) || a_block.parentNode !== this.m_root) return false;

    // カーソル位置で今の段落を分ける（カーソルより後ろの部分を tail に取り出す）
    range.deleteContents();
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(a_block, a_block.childNodes.length);
    const tail = tailRange.extractContents();
    removePlaceholderBreak(a_block);

    // 最初のブロックが段落なら、今の段落の続きにする
    let rest = blocks;
    if ('paragraph' === blocks[0].type) {
      a_block.append(htmlToFragment(renderInline(isHeading ? blocks[0].text.replace(/\n/g, ' ') : blocks[0].text)));
      rest = blocks.slice(1);
    }
    const nodes = rest.flatMap((b) => htmlToNodes(renderBlock(b)));
    a_block.after(...nodes);
    // 今の段落が空のまま残った場合（空の行に見出し等を貼った場合）は取り除く
    let last = nodes.length ? nodes[nodes.length - 1] : a_block;
    if (isEmptyBlock(a_block) && nodes.length) a_block.remove();

    // カーソルより後ろにあった文字を、最後のブロックが段落ならその続きに、それ以外なら新しい段落にする
    const tailHasContent = '' !== tail.textContent.replace(/\u200b/g, '') || tail.querySelector && tail.querySelector('img');
    let caretTarget = null;
    if ('P' === last.tagName && last.parentNode === this.m_root) {
      removePlaceholderBreak(last);
      const marker = document.createTextNode('\u200b');
      last.append(marker);
      if (tailHasContent) last.append(tail);
      caretTarget = marker;
    } else if (tailHasContent) {
      const p = document.createElement('p');
      p.append(tail);
      last.after(p);
    }
    if (caretTarget) {
      const caret = document.createRange();
      caret.setStart(caretTarget, 1);
      caret.collapse(true);
      sel.removeAllRanges();
      sel.addRange(caret);
    } else {
      placeCaretAtEnd(last);
    }
    return true;
  }

  /**
   * Markdown の1つの段落の文字を、太字・リンク等の書式にしてカーソル位置に挿入する。
   * @param {string} a_text 段落の文字（改行を含む場合は、段落の中の改行になる）
   */
  insertInlineMarkdown(a_text) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const block = this.currentTextBlock();
    if (block) removePlaceholderBreak(block);
    const fragment = htmlToFragment(renderInline(a_text));
    // 挿入した書式の外側にカーソルを置くための目印（ゼロ幅の空白。保存時には取り除く）
    const marker = document.createTextNode('\u200b');
    fragment.append(marker);
    range.insertNode(fragment);
    const caret = document.createRange();
    caret.setStart(marker, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
  }
}

/**
 * HTML の文字列から、ノードの集まり（DocumentFragment）を作る。
 * @param {string} a_html HTML
 * @returns {DocumentFragment}
 */
function htmlToFragment(a_html) {
  const template = document.createElement('template');
  template.innerHTML = a_html;
  return template.content;
}

/**
 * HTML の文字列から、要素の配列を作る（ブロックの HTML 用）。
 * @param {string} a_html HTML
 * @returns {Element[]}
 */
function htmlToNodes(a_html) {
  return [...htmlToFragment(a_html).children];
}

/**
 * 項目自身の中身が空で、入れ子のリストだけを持つ場合に、項目自身の行を作る（入れ子のリストの前に <br> を置く）。
 * <br> が無いと、項目の記号と入れ子のリストの記号が同じ行に並び（「・ ◦ 見出し」）、カーソルも置けないため。
 * @param {HTMLLIElement} a_li リストの項目
 * @returns {HTMLBRElement|null} 項目自身の行の <br>（中身がある項目・入れ子のリストが無い項目は null）
 */
function ensureOwnLine(a_li) {
  const first = [...a_li.childNodes].find((n) => !(1 === n.nodeType && 'INPUT' === n.tagName)
    && !(3 === n.nodeType && '' === n.data.replace(/\u200b/g, '').trim()));
  if (!first || 1 !== first.nodeType) return null;
  if ('BR' === first.tagName) {
    const next = first.nextElementSibling;
    return next && ('UL' === next.tagName || 'OL' === next.tagName) ? first : null;
  }
  if ('UL' !== first.tagName && 'OL' !== first.tagName) return null;
  const br = document.createElement('br');
  first.before(br);
  return br;
}

/**
 * 中身が空のブロック（文字も画像も無い）か。カーソルを置くための <br> や目印の文字だけのものも空とみなす。
 * @param {HTMLElement} a_el 段落・見出し等
 * @returns {boolean}
 */
function isEmptyBlock(a_el) {
  return '' === a_el.textContent.replace(/[\u200b\u00a0]/g, '').trim() && !a_el.querySelector('img');
}

/**
 * 空の行を表示するためにブラウザが置いた、最後の <br> を取り除く（文字を書き足す前に使う）。
 * @param {HTMLElement} a_el 段落・見出し等
 */
function removePlaceholderBreak(a_el) {
  const last = a_el.lastChild;
  if (last && 'BR' === last.nodeName && !last.dataset.soft) last.remove();
}

/**
 * 要素の最後にカーソルを置く。リスト・表等の場合は、最後の項目・セルの最後に置く。
 * @param {Element} a_el 要素
 */
function placeCaretAtEnd(a_el) {
  const blocks = a_el.matches(TEXT_BLOCK_SELECTOR) ? [a_el] : [...a_el.querySelectorAll(TEXT_BLOCK_SELECTOR)];
  const target = blocks.length ? blocks[blocks.length - 1] : a_el;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * 文字の書式。command はブラウザ標準の書式の切り替え（execCommand）、tag は自前で囲む要素。
 * key はメニューに表示するショートカット、match はそのキーが押されたかの判定。
 */
const FORMATS = {
  bold: { label: '太字', key: 'Ctrl+B', command: 'bold', match: (e) => ctrlKey(e, 'b') },
  italic: { label: '斜体', key: 'Ctrl+I', command: 'italic', match: (e) => ctrlKey(e, 'i') },
  underline: { label: '下線', key: 'Ctrl+U', command: 'underline', match: (e) => ctrlKey(e, 'u') },
  // 取り消し線：Alt+Shift+5
  strike: { label: '取り消し線', key: 'Alt+Shift+5', command: 'strikeThrough',
    match: (e) => e.altKey && e.shiftKey && !e.ctrlKey && 'Digit5' === e.code },
  // インラインコード：Ctrl+Shift+`（日本語キーボードでは Ctrl+Shift+@ の位置）
  code: { label: 'インラインコード', key: 'Ctrl+Shift+`', tag: 'code',
    match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && ('`' === e.key || 'Backquote' === e.code) },
  mark: { label: 'ハイライト', key: '', tag: 'mark' },
};

/**
 * Ctrl＋文字キー（Shift・Alt なし）が押されたか。
 * @param {KeyboardEvent} e
 * @param {string} a_key 文字キー（小文字）
 * @returns {boolean}
 */
function ctrlKey(e, a_key) {
  return e.ctrlKey && !e.shiftKey && !e.altKey && a_key === e.key.toLowerCase();
}

/**
 * チェックボックスの項目に置くチェックボックスを作る（文字の編集の対象にならないよう contenteditable=false）。
 * @param {boolean} a_checked チェックを付けるか
 * @returns {HTMLInputElement}
 */
function createCheckbox(a_checked) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.contentEditable = 'false';
  if (a_checked) box.setAttribute('checked', '');
  box.checked = a_checked;
  return box;
}

/**
 * 文書で最も多く使われている箇条書きの記号（無ければ「-」）。新しく作るリストに使う。
 * @param {string} a_markdown 文書の全体
 * @returns {string} '-'・'*'・'+' のどれか
 */
function detectBulletMarker(a_markdown) {
  const counts = { '-': 0, '*': 0, '+': 0 };
  for (const m of (a_markdown || '').matchAll(/^[ \t]*([-*+])[ \t]+\S/gm)) counts[m[1]]++;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '-';
}

/** 開いているメニュー（showMenu）を閉じる関数（開いていなければ null）。 */
let s_closeMenu = null;

/** 開いているメニュー（showMenu）があれば閉じる。 */
export function closeMenu() {
  if (s_closeMenu) s_closeMenu();
}

/** サブメニューを持つ項目にマウスを乗せてから開くまで・ほかの項目へ移ってから閉じるまでの時間（ミリ秒。Windows の
 * メニューの既定値と同じ）。 */
const SUBMENU_HOVER_DELAY_MS = 400;

/**
 * 右クリックのメニューを表示する（main.js の「ファイル」のメニューでも使う）。項目を選ぶか、メニューの外をクリックする・Esc キーで閉じる。
 * @param {number} a_x 表示する位置（画面の左上からの座標。画面からはみ出す場合は内側にずらす）
 * @param {number} a_y
 * @param {({label:string, key?:string, checked?:boolean, disabled?:boolean, heading?:boolean, title?:string, path?:boolean,
 *   submenu?:object[]}|null)[]} a_items
 *   項目。null は区切り線。key はショートカットの表示、checked は項目の左にチェックの印を付ける（その書式になっている）、
 *   heading は選べない見出し（下の項目のまとまりの名前）、title はマウスを乗せた時に出す説明、
 *   path は label がファイル・フォルダのパスか（幅が足りない時に、名前を残してフォルダの部分を「…」にする）、
 *   submenu はサブメニューの項目（項目をクリックするか、マウスを乗せてしばらくすると右側に開く。項目の形は a_items と同じ）
 * @param {(item:object)=>void} a_onSelect 項目が選ばれた時に呼ぶ関数（選ばれた項目を渡す。サブメニューの項目も同じ）
 * @param {{keyboard?:boolean, onNavigate?:(dir:number)=>void}} [a_opts] keyboard はキーボードで開いたか（最初の項目を
 *   選んだ状態で開く）、onNavigate はメニューバーのメニューで、左右の矢印キーで隣のメニューへ移る時に呼ぶ関数
 *   （dir は右が 1、左が -1。メニューは閉じてから呼ぶ）
 *
 * キーボードの操作（Windows のメニューと同じ）：上下の矢印キーで項目を選ぶ、Enter・スペースで実行する（サブメニューを
 * 持つ項目は開く）、右の矢印キーでサブメニューを開く、左の矢印キーでサブメニューを閉じる、Esc で閉じる。
 */
export function showMenu(a_x, a_y, a_items, a_onSelect, a_opts = {}) {
  // 開いているメニューがあれば閉じる（キーボード等の受け付けも終える）
  if (s_closeMenu) s_closeMenu();
  document.querySelectorAll('.md-menu').forEach((m) => m.remove());
  /** 開いているサブメニュー（無ければ null）。 */
  let sub = null;
  /** マウスを乗せてしばらくしたらサブメニューを開く・閉じるためのタイマー（SUBMENU_HOVER_DELAY_MS 参照）。 */
  let openTimer = 0;
  let closeTimer = 0;
  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  };
  const closeSub = () => {
    clearTimers();
    if (sub) sub.remove();
    sub = null;
    document.querySelectorAll('.md-menu button.submenu-open').forEach((b) => b.classList.remove('submenu-open'));
  };

  /**
   * メニューの要素を作る。
   * @param {object[]} a_list 項目
   * @param {boolean} a_isSub サブメニューか
   * @returns {HTMLElement}
   */
  const build = (a_list, a_isSub) => {
    const el = document.createElement('div');
    el.className = a_isSub ? 'md-menu md-submenu' : 'md-menu';
    for (const item of a_list) {
      if (!item) {
        el.appendChild(document.createElement('hr'));
        continue;
      }
      if (item.heading) {
        // 選べない見出し（下の項目のまとまりの名前）
        const heading = el.appendChild(document.createElement('div'));
        heading.className = 'heading';
        heading.textContent = item.label;
        continue;
      }
      const button = document.createElement('button');
      const check = button.appendChild(document.createElement('span'));
      check.className = 'check';
      check.textContent = item.checked ? '✓' : '';
      const label = button.appendChild(document.createElement('span'));
      label.className = 'label';
      const sep = item.path ? Math.max(item.label.lastIndexOf('\\'), item.label.lastIndexOf('/')) : -1;
      if (sep > 0) {
        // ファイル・フォルダのパス：メニューの幅が足りない時は、フォルダの部分を「…」にして、名前（最後の部分）は残す
        label.classList.add('path');
        const dir = label.appendChild(document.createElement('span'));
        dir.className = 'dir';
        dir.textContent = item.label.slice(0, sep + 1);
        const name = label.appendChild(document.createElement('span'));
        name.className = 'name';
        name.textContent = item.label.slice(sep + 1);
      } else {
        label.textContent = item.label;
      }
      if (item.title) button.title = item.title;
      const key = button.appendChild(document.createElement('span'));
      key.className = 'key';
      key.textContent = item.submenu ? '▸' : item.key || '';
      button.disabled = !!item.disabled;
      button.menuItem = item;
      // mousedown で既定の動作を止めて、編集中のカーソル位置（選択範囲）を保つ
      button.addEventListener('mousedown', (e) => e.preventDefault());
      // マウスを乗せた項目を、キーボードで操作する時の選んだ項目にする
      button.addEventListener('mouseenter', () => setActive(button));
      if (item.submenu) {
        // サブメニュー：クリックすると右側に開く（もう一度クリックすると閉じる）。マウスを乗せた時は、しばらく
        // （SUBMENU_HOVER_DELAY_MS）乗せたままにした時だけ開く（Windows のメニューと同じ。最近使ったファイル等の
        // 長いサブメニューが、下の項目へマウスを動かす途中で開いて、ほかの項目を隠してしまわないように）
        button.classList.add('has-submenu');
        const isOpen = () => sub && sub.dataset.owner === item.label;
        button.addEventListener('click', () => {
          clearTimers();
          if (isOpen()) closeSub();
          else openSub(button, item);
        });
        button.addEventListener('mouseenter', () => {
          clearTimers();
          if (!isOpen()) openTimer = setTimeout(() => openSub(button, item), SUBMENU_HOVER_DELAY_MS);
        });
        button.addEventListener('mouseleave', () => clearTimeout(openTimer));
      } else {
        // 親のメニューのほかの項目にマウスを乗せたら、しばらくしてサブメニューを閉じる（その間にサブメニューへ
        // マウスを移せば閉じない）
        if (!a_isSub) {
          button.addEventListener('mouseenter', () => {
            clearTimers();
            if (sub) closeTimer = setTimeout(closeSub, SUBMENU_HOVER_DELAY_MS);
          });
        }
        button.addEventListener('click', () => {
          close();
          a_onSelect(item);
        });
      }
      el.appendChild(button);
    }
    // マウスを動かしたら、キーボードで操作している時の表示（kbd）をやめる
    el.addEventListener('mousemove', () => el.classList.remove('kbd'));
    return el;
  };

  /**
   * 項目を、選んだ状態（キーボードで操作する対象）にする。親のメニューの項目を選んだ時は、サブメニューの選択を外す。
   * @param {HTMLElement} a_button 項目
   */
  const setActive = (a_button) => {
    const owner = a_button.parentElement;
    owner.querySelectorAll(':scope > button.active').forEach((b) => b.classList.remove('active'));
    a_button.classList.add('active');
    if (sub && owner !== sub) sub.querySelectorAll(':scope > button.active').forEach((b) => b.classList.remove('active'));
  };
  /** メニューの中の、選んだ項目（無ければ null）。 */
  const activeOf = (a_el) => a_el.querySelector(':scope > button.active');
  /**
   * 選んだ項目を、上下の項目に移す（使えない項目は飛ばす。端まで来たら反対の端へ）。
   * @param {HTMLElement} a_el メニュー
   * @param {number} a_dir 下が 1、上が -1
   */
  const moveActive = (a_el, a_dir) => {
    const list = [...a_el.querySelectorAll(':scope > button:not(:disabled)')];
    if (!list.length) return;
    const cur = list.indexOf(activeOf(a_el));
    const next = cur < 0 ? (a_dir > 0 ? 0 : list.length - 1) : (cur + a_dir + list.length) % list.length;
    setActive(list[next]);
    list[next].scrollIntoView({ block: 'nearest' });
  };

  /**
   * サブメニューを、親のメニューの右側に開く。右に収まらない場合は左側に開く。どちらにも収まらない場合は、
   * 広い方に、収まる幅に縮めて開く（長い項目は「…」にする）。どの場合も、親のメニューには重ねない。
   * @param {HTMLElement} a_button サブメニューを持つ項目
   * @param {object} a_item その項目
   */
  const openSub = (a_button, a_item, a_keyboard = false) => {
    closeSub();
    sub = build(a_item.submenu, true);
    sub.dataset.owner = a_item.label;
    // サブメニューへマウスを移したら、閉じる予定を取り消す
    sub.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    a_button.classList.add('submenu-open'); // サブメニューを開いている間は、項目を選んだ色のままにする
    document.body.appendChild(sub);
    const r = a_button.getBoundingClientRect();
    const parent = a_button.closest('.md-menu').getBoundingClientRect();
    // 親のメニューの右側・左側に使える幅（画面の端から 4px は空ける。親のメニューとは 2px だけ重ねて、つながって見せる）
    const rightSpace = window.innerWidth - 4 - (parent.right - 2);
    const leftSpace = parent.left + 2 - 4;
    let width = sub.getBoundingClientRect().width;
    const toRight = width <= rightSpace || (width > leftSpace && rightSpace >= leftSpace);
    const space = toRight ? rightSpace : leftSpace;
    if (width > space) {
      // どちらにも収まらない：広い方の幅に縮める（枠線の分を除いた幅を指定する）
      sub.style.maxWidth = `${Math.max(0, space - 2)}px`;
      width = sub.getBoundingClientRect().width;
    }
    const height = sub.getBoundingClientRect().height;
    sub.style.left = `${toRight ? parent.right - 2 : parent.left + 2 - width}px`;
    sub.style.top = `${Math.max(4, Math.min(r.top - 5, window.innerHeight - height - 4))}px`;
    if (a_keyboard) {
      // キーボードで開いた時は、サブメニューの最初の項目を選ぶ
      sub.classList.add('kbd');
      moveActive(sub, 1);
    }
  };

  const menu = build(a_items, false);
  document.body.appendChild(menu);
  // 画面の外にはみ出さないよう位置を調整する
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(a_x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(a_y, window.innerHeight - rect.height - 4)}px`;
  const onOutside = (e) => {
    if (!menu.contains(e.target) && !(sub && sub.contains(e.target))) close();
  };
  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // 操作の対象：サブメニューの項目を選んでいればサブメニュー、それ以外は親のメニュー
    const level = sub && activeOf(sub) ? sub : menu;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
      level.classList.add('kbd');
    };
    const active = activeOf(level);
    switch (e.key) {
      case 'Escape':
        // サブメニューが開いていれば、サブメニューだけを閉じる（Windows のメニューと同じ）
        handled();
        if (sub) closeSub();
        else close();
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        handled();
        moveActive(level, 'ArrowDown' === e.key ? 1 : -1);
        break;
      case 'ArrowRight':
        handled();
        if (level === menu && active && active.menuItem.submenu) {
          openSub(active, active.menuItem, true);
        } else if (a_opts.onNavigate) {
          close();
          a_opts.onNavigate(1);
        }
        break;
      case 'ArrowLeft':
        handled();
        if (level === sub) {
          closeSub();
        } else if (a_opts.onNavigate) {
          close();
          a_opts.onNavigate(-1);
        }
        break;
      case 'Enter':
      case ' ':
        if (!active) return;
        handled();
        if (active.menuItem.submenu) openSub(active, active.menuItem, true);
        else active.click();
        break;
      default:
    }
  };
  if (a_opts.keyboard) {
    // キーボードで開いた時は、最初の項目を選んだ状態にする
    menu.classList.add('kbd');
    moveActive(menu, 1);
  }
  s_closeMenu = close;
  function close() {
    if (s_closeMenu === close) s_closeMenu = null;
    clearTimers();
    menu.remove();
    closeSub();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  }
  // キーボードの操作はすぐに受け付ける（開いた直後の矢印キーも効くように）。外のクリック等は、メニューを開いたクリックが
  // 届き終わってから受け付ける（すでに閉じていれば受け付けない）
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    if (!menu.isConnected) return;
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', close);
  }, 0);
}
