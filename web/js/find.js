// mdew：検索と置換（mde の「検索と置換」ウィンドウと同じ内容。Ctrl+F・メニューバーの「検索と置換」で開く）。
//
// 画面の右上に重ねて表示する、閉じるまで編集もできる小さなウィンドウ（パネル）。
//  - 対象範囲：「現在のファイル」か「フォルダ全体（サブフォルダ含む）」（フォルダを開いている時だけ選べる）。
//  - 大文字・小文字を区別する／正規表現を使用する（置換後の文字列では $1 等の後方参照が使える）。
//  - 前を検索・次を検索・すべて検索、（置換後の文字列を開いた時）1件ずつ置換…・すべて置換。
//
// 検索する文字の扱いは mde と同じく、操作によって2通り。
//  - 開いているファイルの画面の文字：現在のファイルの 前を検索・次を検索・すべて検索・1件ずつ置換、
//    開いたファイルの強調表示。Markdown モードでは、段落・見出し・リストの項目・表のセル・コードブロックごとに、
//    書式をまたいで探す（mde は書式の境目で切れる）。ソースモードでは、Markdown のソースをそのまま探す
//    （mde はソースモードでは見つからない）。この2つの違いは DocTarget・SourceTarget にまとめてある。
//  - Markdown のソース：現在のファイルの すべて置換、フォルダ全体の すべて検索・すべて置換・1件ずつ置換。
//    「**」やリンクの URL なども対象になる。
// 見つかった箇所は、文書を書き換えずに色を付ける（Markdown モードは CSS Custom Highlight API、ソースモードは
// 入力欄の後ろに重ねた要素。どちらも未保存にならない）。
// フォルダ全体の置換は、保存するまでファイルには書き出さない（main.js が「保存していない内容」として持つ）。

/** 検索結果の一覧に出す段落の文字数（これより長い場合は切り詰めて「…」を付ける。mde と同じ）。 */
const RESULT_TEXT_MAX = 70;
/** 1件ずつ置換で、見つかった箇所の前後に表示する文字数（mde と同じ）。 */
const CONTEXT_CHARS = 30;
/** 一度に色を付ける最大の件数（mde と同じ）。 */
const HIGHLIGHT_MAX = 5000;
/** 段落などのまとまり（この要素ごとに文字を探す）。 */
const BLOCK_TAGS = /^(P|H[1-6]|LI|TD|TH|PRE|BLOCKQUOTE|UL|OL|TABLE|THEAD|TBODY|TR|HR|DIV|SECTION)$/;

/**
 * 正規表現の特殊文字をエスケープする（正規表現を使わない検索用）。
 * @param {string} a_text 文字列
 * @returns {string}
 */
function escapeRegExp(a_text) {
  return a_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 置換後の文字列の $1・$&・$<名前> 等を、見つかった内容で置き換える（String.prototype.replace と同じ規則）。
 * @param {RegExpExecArray} a_match 見つかった内容
 * @param {string} a_replacement 置換後の文字列（正規表現を使わない時は、そのまま使う）
 * @param {boolean} a_useRegex 正規表現を使うか
 * @returns {string}
 */
function expandReplacement(a_match, a_replacement, a_useRegex) {
  if (!a_useRegex) return a_replacement;
  return a_replacement.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (all, token, name) => {
    if ('$' === token) return '$';
    if ('&' === token) return a_match[0];
    if ('`' === token) return a_match.input.slice(0, a_match.index);
    if ("'" === token) return a_match.input.slice(a_match.index + a_match[0].length);
    if (undefined !== name) return a_match.groups && name in a_match.groups ? (a_match.groups[name] ?? '') : all;
    // $nn は、その番号のグループがあれば2桁、無ければ1桁として扱う
    let n = Number(token);
    if (token.length === 2 && n >= a_match.length) {
      n = Number(token[0]);
      return n > 0 && n < a_match.length ? (a_match[n] ?? '') + token[1] : all;
    }
    return n > 0 && n < a_match.length ? (a_match[n] ?? '') : all;
  });
}

/**
 * 文字列の中の、見つかった箇所をすべて返す（長さ 0 の一致は飛ばす）。
 * @param {string} a_text 文字列
 * @param {RegExp} a_re 検索する正規表現（g 付き）
 * @returns {RegExpExecArray[]}
 */
function findAllIn(a_text, a_re) {
  const result = [];
  a_re.lastIndex = 0;
  let m;
  while ((m = a_re.exec(a_text))) {
    if (0 === m[0].length) {
      a_re.lastIndex++;
      continue;
    }
    result.push(m);
    if (result.length >= HIGHLIGHT_MAX) break;
  }
  return result;
}

/**
 * 一覧に出す文字（前後の空白を除き、長ければ切り詰める）。
 * @param {string} a_text 段落・行の文字
 * @param {string} a_fallback 空の時に出す文字（見つかった文字）
 * @returns {string}
 */
function resultLabel(a_text, a_fallback) {
  const text = a_text.replace(/​/g, '').replace(/\s+/g, ' ').trim() || a_fallback;
  return text.length > RESULT_TEXT_MAX ? `${text.slice(0, RESULT_TEXT_MAX)}…` : text;
}

/**
 * 画面の文字を、段落などのまとまりごとに集める。各まとまりは、文字列と、各文字が画面のどの文字
 * （テキストノードと位置）に当たるかを持つ。改行（<br>）でもまとまりを分ける。カーソル用の目印の文字（U+200B）は除く。
 * @param {HTMLElement} a_root 文書の要素
 * @returns {{text: string, nodes: Text[], offsets: number[], block: Element}[]}
 */
function collectSegments(a_root) {
  const segments = [];
  let current = null;
  const walk = (a_node) => {
    for (const child of a_node.childNodes) {
      if (3 === child.nodeType) {
        if (!current) {
          current = { text: '', nodes: [], offsets: [], block: child.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,pre') || child.parentElement };
          segments.push(current);
        }
        const data = child.data;
        for (let i = 0; i < data.length; i++) {
          if ('​' === data[i]) continue;
          current.text += data[i];
          current.nodes.push(child);
          current.offsets.push(i);
        }
      } else if (1 === child.nodeType) {
        if ('BR' === child.tagName) {
          current = null;
        } else if (BLOCK_TAGS.test(child.tagName)) {
          current = null;
          walk(child);
          current = null;
        } else {
          walk(child);
        }
      }
    }
  };
  walk(a_root);
  return segments;
}

/**
 * 文書の中の2つの位置を比べる。
 * @param {Node} a_node 位置 A のノード
 * @param {number} a_offset 位置 A のオフセット
 * @param {Node} b_node 位置 B のノード
 * @param {number} b_offset 位置 B のオフセット
 * @returns {number} A が B より後ろなら正、同じなら 0、前なら負
 */
function comparePoints(a_node, a_offset, b_node, b_offset) {
  const r = document.createRange();
  r.setStart(a_node, a_offset);
  r.collapse(true);
  return -r.comparePoint(b_node, b_offset);
}

// ===== 開いているファイルの中での検索（Markdown モード・ソースモード）=====
// どちらも同じ形の機能を持つ。見つかった箇所（match）は、それぞれの形のオブジェクトで、共通して
// match（RegExpExecArray）と label（一覧に出す文字）を持つ。基準の位置（anchor）も、それぞれの形。

/** Markdown モード：画面の文字で探し、Range で表す。 */
class DocTarget {
  /**
   * @param {object} a_deps FindPanel と同じ
   */
  constructor(a_deps) {
    this.d = a_deps;
    /** 今の箇所の Range（色はオレンジ）。 */
    this.m_current = null;
  }

  /**
   * 見つかった箇所をすべて探す。
   * @param {RegExp} a_re 正規表現
   * @returns {{range: Range, match: RegExpExecArray, label: string}[]}
   */
  find(a_re) {
    const result = [];
    for (const seg of collectSegments(this.d.doc)) {
      for (const m of findAllIn(seg.text, a_re)) {
        const s = m.index;
        const e = m.index + m[0].length - 1;
        const range = document.createRange();
        range.setStart(seg.nodes[s], seg.offsets[s]);
        range.setEnd(seg.nodes[e], seg.offsets[e] + 1);
        result.push({ range, match: m, label: resultLabel(seg.block.textContent || '', m[0]) });
        if (result.length >= HIGHLIGHT_MAX) return result;
      }
    }
    return result;
  }

  /**
   * 基準の位置（直前の箇所、無ければカーソル位置、無ければ文書の先頭）。
   * @returns {Range}
   */
  anchor() {
    if (this.m_current && this.d.doc.contains(this.m_current.startContainer)) return this.m_current;
    const sel = getSelection();
    if (sel.rangeCount && this.d.doc.contains(sel.getRangeAt(0).startContainer)) return sel.getRangeAt(0);
    const range = document.createRange();
    range.setStart(this.d.doc, 0);
    range.collapse(true);
    return range;
  }

  /**
   * 基準の位置の次（前）の箇所の番号。
   * @param {object[]} a_matches 見つかった箇所
   * @param {Range} a_anchor 基準の位置
   * @param {boolean} a_backward 前を検索か
   * @param {boolean} a_wrap 端まで行ったら反対の端に戻るか
   * @returns {number} 無ければ -1
   */
  pick(a_matches, a_anchor, a_backward, a_wrap) {
    if (!a_matches.length) return -1;
    if (a_backward) {
      // 基準の位置の始まりより前で始まる、最後の箇所
      for (let i = a_matches.length - 1; i >= 0; i--) {
        const r = a_matches[i].range;
        if (comparePoints(r.startContainer, r.startOffset, a_anchor.startContainer, a_anchor.startOffset) < 0) return i;
      }
      return a_wrap ? a_matches.length - 1 : -1;
    }
    // 基準の位置の終わりと同じか、それより後ろで始まる、最初の箇所（基準が今の箇所なら、それ自身は含まない）
    for (let i = 0; i < a_matches.length; i++) {
      const r = a_matches[i].range;
      if (comparePoints(r.startContainer, r.startOffset, a_anchor.endContainer, a_anchor.endOffset) >= 0) return i;
    }
    return a_wrap ? 0 : -1;
  }

  /**
   * 見つかった箇所すべてに色を付け、アウトラインの見出しにも印を付ける。
   * @param {object[]} a_matches 見つかった箇所
   */
  highlight(a_matches) {
    if (window.CSS && CSS.highlights) CSS.highlights.set('find-all', new Highlight(...a_matches.map((m) => m.range)));
    this.updateOutlineMarks(a_matches);
  }

  /**
   * 今の箇所にオレンジの色を付け、見える位置までスクロールし、選択する（パネルの入力欄はそのまま使える）。
   * @param {object} a_match 見つかった箇所
   * @param {object[]} a_matches 見つかった箇所すべて（アウトラインの印に使う）
   */
  select(a_match, a_matches) {
    this.m_current = a_match.range;
    if (window.CSS && CSS.highlights) CSS.highlights.set('find-current', new Highlight(a_match.range));
    const target = a_match.range.startContainer.parentElement;
    if (target) target.scrollIntoView({ block: 'center' });
    const active = document.activeElement;
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(a_match.range.cloneRange());
    if (active && document.activeElement !== active) active.focus();
    this.updateOutlineMarks(a_matches);
  }

  /** 今の箇所のオレンジの色を消す。 */
  clearCurrent() {
    this.m_current = null;
    if (window.CSS && CSS.highlights) CSS.highlights.delete('find-current');
  }

  /** 色・アウトラインの印をすべて消す。 */
  clear() {
    this.clearCurrent();
    if (window.CSS && CSS.highlights) CSS.highlights.delete('find-all');
    this.d.setOutlineMarks(new Set(), null);
  }

  /** 今の箇所が、編集で消えていれば忘れる。 */
  dropStaleCurrent() {
    if (this.m_current && this.m_current.collapsed) this.clearCurrent();
  }

  /**
   * 箇所の直後の位置（スキップした時の次の基準）。
   * @param {object} a_match 見つかった箇所
   * @returns {Range}
   */
  after(a_match) {
    const r = document.createRange();
    r.setStart(a_match.range.endContainer, a_match.range.endOffset);
    r.collapse(true);
    return r;
  }

  /**
   * 箇所を置き換える（元に戻すで1回で戻せる）。
   * @param {{match: object, text: string}[]} a_items 置き換える箇所と文字（文書の順）
   * @returns {Range|null} 最初の箇所を置き換えた文字の直後の位置
   */
  replace(a_items) {
    this.m_current = null;
    return this.d.editor.replaceRanges(a_items.map((x) => ({ range: x.match.range, text: x.text })));
  }

  /**
   * 2つの箇所が同じ位置で始まるか。
   * @param {object} a_x 箇所
   * @param {object} a_y 箇所
   * @returns {boolean}
   */
  same(a_x, a_y) {
    return 0 === a_x.range.compareBoundaryPoints(Range.START_TO_START, a_y.range);
  }

  /**
   * アウトラインの見出しのうち、見つかった箇所を含む見出しに印を付ける（今の箇所の見出しは選択した色）。
   * @param {object[]} a_matches 見つかった箇所
   */
  updateOutlineMarks(a_matches) {
    const headings = this.d.editor.headings();
    const owner = (a_range) => {
      let found = null;
      for (const h of headings) {
        if (a_range.comparePoint(h, 0) <= 0) found = h;
        else break;
      }
      return found;
    };
    const hits = new Set();
    for (const m of a_matches) {
      const h = owner(m.range);
      if (h) hits.add(h);
    }
    this.d.setOutlineMarks(hits, this.m_current ? owner(this.m_current) : null);
  }
}

/** ソースモード：入力欄（textarea）の Markdown のソースで探し、文字の位置で表す。 */
class SourceTarget {
  /**
   * @param {object} a_deps FindPanel と同じ（source：main.js のソースモードの機能）
   */
  constructor(a_deps) {
    this.d = a_deps;
    /** 今の箇所（{start, end}）。 */
    this.m_current = null;
  }

  /** 入力欄。 */
  get area() {
    return this.d.source.area;
  }

  /**
   * 見つかった箇所をすべて探す。
   * @param {RegExp} a_re 正規表現
   * @returns {{start: number, end: number, match: RegExpExecArray, label: string}[]}
   */
  find(a_re) {
    const text = this.area.value;
    return findAllIn(text, a_re).map((m) => {
      const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
      let lineEnd = text.indexOf('\n', m.index);
      if (lineEnd < 0) lineEnd = text.length;
      return { start: m.index, end: m.index + m[0].length, match: m, label: resultLabel(text.slice(lineStart, lineEnd), m[0]) };
    });
  }

  /**
   * 基準の位置（直前の箇所、無ければ入力欄の選択範囲）。
   * @returns {{start: number, end: number}}
   */
  anchor() {
    if (this.m_current) return this.m_current;
    return { start: this.area.selectionStart, end: this.area.selectionEnd };
  }

  /**
   * 基準の位置の次（前）の箇所の番号。
   * @param {object[]} a_matches 見つかった箇所
   * @param {{start: number, end: number}} a_anchor 基準の位置
   * @param {boolean} a_backward 前を検索か
   * @param {boolean} a_wrap 端まで行ったら反対の端に戻るか
   * @returns {number} 無ければ -1
   */
  pick(a_matches, a_anchor, a_backward, a_wrap) {
    if (!a_matches.length) return -1;
    if (a_backward) {
      for (let i = a_matches.length - 1; i >= 0; i--) if (a_matches[i].start < a_anchor.start) return i;
      return a_wrap ? a_matches.length - 1 : -1;
    }
    for (let i = 0; i < a_matches.length; i++) if (a_matches[i].start >= a_anchor.end) return i;
    return a_wrap ? 0 : -1;
  }

  /**
   * 見つかった箇所すべてに色を付ける。
   * @param {object[]} a_matches 見つかった箇所
   */
  highlight(a_matches) {
    this.m_all = a_matches;
    this.d.source.highlight(a_matches, this.m_current);
    this.d.setOutlineMarks(new Set(), null);
  }

  /**
   * 今の箇所にオレンジの色を付けて選択し、見える位置までスクロールする。
   * @param {object} a_match 見つかった箇所
   * @param {object[]} a_matches 見つかった箇所すべて
   */
  select(a_match, a_matches) {
    this.m_current = { start: a_match.start, end: a_match.end };
    this.area.setSelectionRange(a_match.start, a_match.end);
    this.highlight(a_matches);
    this.d.source.reveal(a_match.start);
  }

  /** 今の箇所のオレンジの色を消す。 */
  clearCurrent() {
    this.m_current = null;
    this.d.source.highlight(this.m_all || [], null);
  }

  /** 色をすべて消す。 */
  clear() {
    this.m_current = null;
    this.m_all = [];
    this.d.source.highlight([], null);
  }

  /** 編集した後は、今の箇所を忘れる（位置がずれるため）。 */
  dropStaleCurrent() {
    this.m_current = null;
  }

  /**
   * 箇所の直後の位置。
   * @param {object} a_match 見つかった箇所
   * @returns {{start: number, end: number}}
   */
  after(a_match) {
    return { start: a_match.end, end: a_match.end };
  }

  /**
   * 箇所を置き換える（入力欄の「元に戻す」で1回で戻せるよう、まとめて1回の入力にする）。
   * @param {{match: object, text: string}[]} a_items 置き換える箇所と文字（文書の順）
   * @returns {{start: number, end: number}|null} 最初の箇所を置き換えた文字の直後の位置
   */
  replace(a_items) {
    if (!a_items.length) return null;
    const first = a_items[0].match.start;
    const last = a_items[a_items.length - 1].match.end;
    const text = this.area.value;
    let out = '';
    let pos = first;
    for (const x of a_items) {
      out += text.slice(pos, x.match.start) + x.text;
      pos = x.match.end;
    }
    out += text.slice(pos, last);
    this.m_current = null;
    this.d.source.replaceRange(first, last, out);
    const end = first + a_items[0].text.length;
    return { start: end, end };
  }

  /**
   * 2つの箇所が同じ位置で始まるか。
   * @param {object} a_x 箇所
   * @param {object} a_y 箇所
   * @returns {boolean}
   */
  same(a_x, a_y) {
    return a_x.start === a_y.start;
  }
}

/** 検索と置換のパネル。 */
export class FindPanel {
  /**
   * @param {object} a_deps 呼び出し元（main.js）の機能
   * @param {import('./editor.js').Editor} a_deps.editor 編集部分
   * @param {HTMLElement} a_deps.doc 文書の要素（#doc）
   * @param {import('./folder.js').FolderView} a_deps.folder フォルダビュー
   * @param {() => string|null} a_deps.currentPath 今開いているファイルのパス（新規の文書は null）
   * @param {() => string} a_deps.currentMarkdown 開いているファイルの今の内容（Markdown）
   * @param {() => Promise<{path: string, text: string}[]>} a_deps.folderFiles フォルダ以下のすべての Markdown ファイルの
   *   今の内容（開いているファイル・保存していない内容を含む。並びはフォルダビューと同じ）
   * @param {(path: string) => Promise<boolean>} a_deps.openFile ファイルを開く（開けたら true）
   * @param {(text: string) => void} a_deps.replaceCurrentMarkdown 開いているファイルの内容を置き換える（未保存にする）
   * @param {(path: string, text: string) => void} a_deps.setPendingText 開いていないファイルの内容を、保存せずに置いておく
   * @param {(hits: Set<Element>, current: Element|null) => void} a_deps.setOutlineMarks アウトラインの見出しに印を付ける
   * @param {object} a_deps.source ソースモードの機能（active・area・highlight・reveal・replaceRange。main.js 参照）
   */
  constructor(a_deps) {
    this.d = a_deps;
    const $ = (id) => document.getElementById(id);
    this.el = {
      panel: $('find-panel'), header: $('find-header'), close: $('find-close'),
      query: $('find-query'), replaceBox: $('find-replace-box'), replacement: $('find-replacement'),
      scopeFile: $('find-scope-file'), scopeFolder: $('find-scope-folder'),
      matchCase: $('find-case'), regex: $('find-regex'),
      prev: $('find-prev'), next: $('find-next'), all: $('find-all'),
      stepReplace: $('find-step-replace'), replaceAll: $('find-replace-all'),
      status: $('find-status'), results: $('find-results'),
      step: $('find-step'), stepFile: $('find-step-file'), stepContext: $('find-step-context'),
      stepDo: $('find-step-do'), stepSkip: $('find-step-skip'), stepRest: $('find-step-rest'), stepEnd: $('find-step-end'),
    };
    this.m_docTarget = new DocTarget(a_deps);
    this.m_sourceTarget = new SourceTarget(a_deps);
    /** 1件ずつ置換の途中の状態（していない時は null）。 */
    this.m_step = null;
    /** 直前の「すべて検索」の検索語（違う検索語で次を検索した時に、結果の一覧を隠すため）。 */
    this.m_lastAllQuery = null;
    this.m_rehighlightTimer = 0;
    this.bind();
  }

  /** 開いているファイルの中での検索の担当（ソースモードなら SourceTarget、それ以外は DocTarget）。 */
  get target() {
    return this.d.source.active() ? this.m_sourceTarget : this.m_docTarget;
  }

  /** ボタン・キー操作を結び付ける。 */
  bind() {
    const e = this.el;
    e.close.addEventListener('click', () => this.close());
    e.prev.addEventListener('click', () => this.findNext(true));
    e.next.addEventListener('click', () => this.findNext(false));
    e.all.addEventListener('click', () => this.findAll());
    e.stepReplace.addEventListener('click', () => this.startStep());
    e.replaceAll.addEventListener('click', () => this.replaceAll());
    e.stepDo.addEventListener('click', () => this.stepReplace());
    e.stepSkip.addEventListener('click', () => this.stepSkip());
    e.stepRest.addEventListener('click', () => this.stepReplaceRest());
    e.stepEnd.addEventListener('click', () => this.finishStep());
    // Enter：すべて検索（mde と同じ）、Esc：閉じる
    e.panel.addEventListener('keydown', (ev) => {
      if ('Escape' === ev.key) { ev.preventDefault(); this.close(); return; }
      if ('Enter' === ev.key && /^(INPUT)$/.test(ev.target.tagName) && 'text' === ev.target.type) {
        ev.preventDefault();
        this.findAll();
      }
    });
    e.replaceBox.addEventListener('toggle', () => this.updateButtons());
    // 見出しをドラッグして動かす
    e.header.addEventListener('pointerdown', (ev) => {
      if (ev.target === e.close) return;
      const rect = e.panel.getBoundingClientRect();
      const dx = ev.clientX - rect.left;
      const dy = ev.clientY - rect.top;
      e.header.setPointerCapture(ev.pointerId);
      const move = (m) => {
        e.panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, m.clientX - dx))}px`;
        e.panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy))}px`;
        e.panel.style.right = 'auto';
      };
      const up = () => {
        e.header.removeEventListener('pointermove', move);
        e.header.removeEventListener('pointerup', up);
      };
      e.header.addEventListener('pointermove', move);
      e.header.addEventListener('pointerup', up);
    });
  }

  /** パネルを開いているか。 */
  get isOpen() {
    return !this.el.panel.hidden;
  }

  /** パネルを開く（開いていれば前に出す）。検索する文字列の欄を選択した状態にする。 */
  open() {
    this.el.panel.hidden = false;
    this.updateScope();
    this.updateButtons();
    this.el.query.focus();
    this.el.query.select();
  }

  /** パネルを閉じる。色・アウトラインとフォルダビューの印を消す。 */
  close() {
    this.endStepSilently();
    this.el.panel.hidden = true;
    this.clearHighlights();
    this.d.folder.clearSearchHits();
    if (this.d.source.active()) this.d.source.area.focus();
    else this.d.editor.focus();
  }

  /** 色・アウトラインの印を、Markdown モード・ソースモードの両方とも消す。 */
  clearHighlights() {
    this.m_docTarget.clear();
    this.m_sourceTarget.clear();
  }

  /** 対象範囲の選択肢を、フォルダを開いているかに合わせる（開いていなければ「現在のファイル」だけ）。 */
  updateScope() {
    const open = this.d.folder.isOpen;
    this.el.scopeFolder.disabled = !open;
    if (!open) this.el.scopeFile.checked = true;
  }

  /** 置換のボタンを、「置換後の文字列」を開いている時だけ表示する（mde と同じ）。 */
  updateButtons() {
    const show = this.el.replaceBox.open;
    this.el.stepReplace.hidden = !show;
    this.el.replaceAll.hidden = !show;
  }

  /** 対象範囲がフォルダ全体か。 */
  get folderScope() {
    return this.el.scopeFolder.checked && this.d.folder.isOpen;
  }

  /**
   * 今の検索条件で正規表現を作る。検索語が空なら null。正規表現の誤りはメッセージを出して null。
   * @returns {RegExp|null}
   */
  buildRegex() {
    const q = this.el.query.value;
    if (!q) return null;
    const flags = this.el.matchCase.checked ? 'g' : 'gi';
    try {
      return new RegExp(this.el.regex.checked ? q : escapeRegExp(q), flags);
    } catch (ex) {
      this.setStatus(`正規表現が正しくありません：${ex.message}`);
      return null;
    }
  }

  /**
   * 状態の表示を変える。
   * @param {string} a_text 表示する文
   */
  setStatus(a_text) {
    this.el.status.textContent = a_text;
  }

  /** 今開いているファイルの名前（新規の文書は「無題」）。 */
  currentName() {
    const p = this.d.currentPath();
    return p ? p.split(/[\\/]/).pop() : '無題';
  }

  // ===== 前を検索・次を検索 =====

  /**
   * 前を検索・次を検索。
   * @param {boolean} a_backward 前を検索か
   */
  async findNext(a_backward) {
    const re = this.buildRegex();
    if (!re) return;
    if (this.m_lastAllQuery !== this.el.query.value) this.hideResults();
    let t = this.target;
    if (!this.folderScope) {
      const matches = t.find(re);
      t.highlight(matches);
      const i = t.pick(matches, t.anchor(), a_backward, true);
      if (i < 0) {
        t.clearCurrent();
        this.setStatus('見つかりませんでした。');
        return;
      }
      t.select(matches[i], matches);
      this.setStatus('見つかりました（エディタ内で強調表示しています）。');
      return;
    }
    // フォルダ全体：今のファイルの中に次（前）の箇所があればそこへ、無ければ次（前）のファイルを開く
    const here = t.find(re);
    const j = t.pick(here, t.anchor(), a_backward, false);
    if (j >= 0) {
      t.highlight(here);
      t.select(here[j], here);
      this.setStatus(`見つかりました：${this.currentName()}（${j + 1} / ${here.length}件目）`);
      return;
    }
    const files = await this.d.folderFiles();
    const hitFiles = files.filter((f) => findAllIn(f.text, re).length);
    if (!hitFiles.length) {
      t.clearCurrent();
      this.setStatus('見つかりませんでした。');
      return;
    }
    const keys = files.map((f) => f.path.toLowerCase());
    const cur = (this.d.currentPath() || '').toLowerCase();
    const start = keys.indexOf(cur);
    // 今のファイルの次（前）から順に、見つかったファイルを探す（フォルダの端まで行ったら反対の端に戻る）
    const n = files.length;
    let target = null;
    for (let k = 1; k <= n; k++) {
      const idx = start < 0 ? (a_backward ? n - k : k - 1) : (start + (a_backward ? -k : k) + n * 2) % n;
      if (hitFiles.includes(files[idx])) { target = files[idx]; break; }
    }
    if (!target) return;
    if (target.path.toLowerCase() !== cur && !(await this.d.openFile(target.path))) return;
    t = this.target;
    const matches = t.find(re);
    t.highlight(matches);
    if (!matches.length) {
      t.clearCurrent();
      this.setStatus(`見つかりました：${this.currentName()}（画面に表示されない部分。リンクの URL 等）`);
      return;
    }
    const k = a_backward ? matches.length - 1 : 0;
    t.select(matches[k], matches);
    this.selectResult(target.path);
    this.setStatus(`見つかりました：${this.currentName()}（${k + 1} / ${matches.length}件目）`);
  }

  // ===== すべて検索 =====

  /** すべて検索。 */
  async findAll() {
    const re = this.buildRegex();
    if (!re) return;
    this.endStepSilently();
    this.m_lastAllQuery = this.el.query.value;
    const t = this.target;
    if (!this.folderScope) {
      this.d.folder.clearSearchHits();
      const matches = t.find(re);
      t.clearCurrent();
      t.highlight(matches);
      if (!matches.length) {
        this.hideResults();
        this.setStatus('見つかりませんでした。');
        return;
      }
      this.showResults(matches.map((m) => ({ label: m.label, open: () => this.goToMatch(m) })));
      const where = this.d.source.active() ? 'エディタ内' : 'エディタ内・アウトライン';
      this.setStatus(`${matches.length} 件見つかりました（すべて${where}で強調表示しています。ダブルクリックでその箇所へ移動します）。`);
      return;
    }
    const files = await this.d.folderFiles();
    const hits = [];
    for (const f of files) {
      const count = findAllIn(f.text, re).length;
      if (count) hits.push({ path: f.path, count });
    }
    t.clearCurrent();
    t.highlight(t.find(re));
    this.d.setOutlineMarks(new Set(), null);
    if (!hits.length) {
      this.hideResults();
      this.d.folder.clearSearchHits();
      this.setStatus('見つかりませんでした。');
      return;
    }
    this.showResults(hits.map((h) => ({
      label: `${this.d.folder.relativePath(h.path) || h.path}　（${h.count}件）`,
      path: h.path,
      open: () => this.openResultFile(h.path),
    })));
    await this.d.folder.setSearchHits(hits.map((h) => h.path));
    this.setStatus(`${hits.length} 個のファイルで見つかりました（フォルダビューでも強調表示しています）。ダブルクリックで開きます。`);
  }

  /**
   * 一覧のダブルクリック（現在のファイル）：その箇所へ移動する。
   * @param {object} a_match 見つかった箇所
   */
  goToMatch(a_match) {
    const re = this.buildRegex();
    if (!re) return;
    const t = this.target;
    const matches = t.find(re);
    const same = matches.find((m) => t.same(m, a_match)) || a_match;
    t.highlight(matches);
    t.select(same, matches);
  }

  /**
   * 一覧のダブルクリック（フォルダ全体）：そのファイルを開き、最初の箇所へ移動する。
   * @param {string} a_path ファイルのパス
   */
  async openResultFile(a_path) {
    const re = this.buildRegex();
    if (!re) return;
    if ((this.d.currentPath() || '').toLowerCase() !== a_path.toLowerCase() && !(await this.d.openFile(a_path))) return;
    const t = this.target;
    const matches = t.find(re);
    t.highlight(matches);
    if (matches.length) t.select(matches[0], matches);
  }

  /**
   * 検索結果の一覧を表示する。
   * @param {{label: string, open: () => void, path?: string}[]} a_items 一覧の行
   */
  showResults(a_items) {
    const ul = this.el.results;
    ul.replaceChildren();
    for (const item of a_items) {
      const li = ul.appendChild(document.createElement('li'));
      li.textContent = item.label;
      if (item.path) li.dataset.path = item.path.toLowerCase();
      li.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });
      li.addEventListener('click', () => this.markResult(li));
      li.addEventListener('dblclick', () => { this.markResult(li); item.open(); });
    }
    ul.hidden = false;
  }

  /**
   * 一覧の行を選択した色にする。
   * @param {HTMLElement} a_li 行
   */
  markResult(a_li) {
    for (const li of this.el.results.children) li.classList.toggle('selected', li === a_li);
  }

  /**
   * フォルダ全体の一覧で、そのファイルの行を選択した色にする。
   * @param {string} a_path ファイルのパス
   */
  selectResult(a_path) {
    const li = [...this.el.results.children].find((x) => x.dataset.path === a_path.toLowerCase());
    if (li) this.markResult(li);
  }

  /** 検索結果の一覧を隠す。 */
  hideResults() {
    this.el.results.hidden = true;
    this.el.results.replaceChildren();
  }

  // ===== すべて置換 =====

  /** すべて置換（Markdown のソースで置き換える。確認は出さない。mde と同じ）。 */
  async replaceAll() {
    const re = this.buildRegex();
    if (!re) return;
    this.endStepSilently();
    const repl = this.el.replacement.value;
    const replaceText = this.el.regex.checked ? repl : repl.replace(/\$/g, '$$$$');
    if (!this.folderScope) {
      const text = this.d.currentMarkdown();
      const count = findAllIn(text, re).length;
      if (count) this.d.replaceCurrentMarkdown(text.replace(re, replaceText));
      this.hideResults();
      this.afterReplace();
      this.setStatus(count ? `${count} 件を置換しました（保存するまでファイルには反映されません）。` : '見つかりませんでした。');
      return;
    }
    const files = await this.d.folderFiles();
    const done = [];
    let total = 0;
    for (const f of files) {
      const count = findAllIn(f.text, re).length;
      if (!count) continue;
      this.applyText(f.path, f.text.replace(re, replaceText));
      done.push({ path: f.path, count });
      total += count;
    }
    this.afterReplace();
    if (!done.length) {
      this.hideResults();
      this.setStatus('見つかりませんでした。');
      return;
    }
    this.showResults(done.map((h) => ({
      label: `${this.d.folder.relativePath(h.path) || h.path}　（${h.count}件置換）`,
      path: h.path,
      open: () => this.openResultFile(h.path),
    })));
    this.setStatus(`${done.length} 個のファイルで合計 ${total} 件を置換しました（保存するまでファイルには書き出されません。メニュー「ファイル」→「すべて保存」で反映してください）。`);
  }

  /**
   * 置換した内容を反映する（開いているファイルは画面の内容を置き換え、それ以外は保存せずに置いておく）。
   * @param {string} a_path ファイルのパス
   * @param {string} a_text 置換した内容
   */
  applyText(a_path, a_text) {
    if ((this.d.currentPath() || '').toLowerCase() === a_path.toLowerCase()) this.d.replaceCurrentMarkdown(a_text);
    else this.d.setPendingText(a_path, a_text);
  }

  /** 置換の後、色を付け直す（置換後の文字で、まだ見つかる箇所があれば色を付ける）。 */
  afterReplace() {
    const t = this.target;
    t.clearCurrent();
    const re = this.buildRegex();
    if (re) t.highlight(t.find(re));
  }

  // ===== 1件ずつ置換 =====

  /** 1件ずつ置換を始める。 */
  async startStep() {
    const re = this.buildRegex();
    if (!re) return;
    this.endStepSilently();
    this.hideResults();
    if (!this.folderScope) {
      // 現在のファイル：カーソル位置から後ろへ、1件ずつ（文書の最後まで。折り返さない）
      const t = this.target;
      t.clearCurrent();
      this.m_step = { folder: false, re, count: 0, target: t, anchor: t.anchor() };
      this.el.stepFile.textContent = '現在のファイル';
      this.el.stepContext.textContent = 'エディタ内で強調表示された箇所をご確認ください。';
      this.el.step.hidden = false;
      this.stepShowNext();
      return;
    }
    // フォルダ全体：フォルダの先頭のファイルから順に、Markdown のソースで1件ずつ
    const files = (await this.d.folderFiles()).filter((f) => findAllIn(f.text, re).length);
    this.m_step = { folder: true, re, count: 0, files, fileIndex: 0, pos: 0, changed: false, touched: 0 };
    this.el.step.hidden = false;
    this.stepShowNext();
  }

  /** 1件ずつ置換：次の箇所を表示する（無ければ終える）。 */
  stepShowNext() {
    const st = this.m_step;
    if (!st) return;
    if (!st.folder) {
      const t = st.target;
      const matches = t.find(st.re);
      t.highlight(matches);
      const i = t.pick(matches, st.anchor, false, false);
      if (i < 0) { this.finishStep(); return; }
      st.match = matches[i];
      t.select(matches[i], matches);
      return;
    }
    while (st.fileIndex < st.files.length) {
      const f = st.files[st.fileIndex];
      st.re.lastIndex = st.pos;
      let m;
      while ((m = st.re.exec(f.text)) && 0 === m[0].length) st.re.lastIndex++;
      if (m) {
        st.match = m;
        this.el.stepFile.textContent = this.d.folder.relativePath(f.path) || f.path;
        const before = f.text.slice(Math.max(0, m.index - CONTEXT_CHARS), m.index);
        const after = f.text.slice(m.index + m[0].length, m.index + m[0].length + CONTEXT_CHARS);
        const clean = (s) => s.replace(/\r/g, '').replace(/\n/g, '⏎');
        this.el.stepContext.textContent = `…${clean(before)}【${clean(m[0])}】${clean(after)}…`;
        return;
      }
      this.stepNextFile();
    }
    this.finishStep();
  }

  /** 1件ずつ置換（フォルダ全体）：今のファイルの変更を反映して、次のファイルへ進む。 */
  stepNextFile() {
    const st = this.m_step;
    const f = st.files[st.fileIndex];
    if (st.changed) {
      this.applyText(f.path, f.text);
      st.touched++;
    }
    st.fileIndex++;
    st.pos = 0;
    st.changed = false;
  }

  /** 1件ずつ置換：今の箇所を置換して、次の箇所へ。 */
  stepReplace() {
    const st = this.m_step;
    if (!st || !st.match) return;
    const useRegex = this.el.regex.checked;
    if (!st.folder) {
      const text = expandReplacement(st.match.match, this.el.replacement.value, useRegex);
      st.anchor = st.target.replace([{ match: st.match, text }]);
    } else {
      const f = st.files[st.fileIndex];
      const m = st.match;
      const text = expandReplacement(m, this.el.replacement.value, useRegex);
      f.text = f.text.slice(0, m.index) + text + f.text.slice(m.index + m[0].length);
      st.pos = m.index + text.length;
      st.changed = true;
    }
    st.count++;
    this.stepShowNext();
  }

  /** 1件ずつ置換：今の箇所を置換せずに、次の箇所へ。 */
  stepSkip() {
    const st = this.m_step;
    if (!st || !st.match) return;
    if (!st.folder) {
      st.anchor = st.target.after(st.match);
      st.target.clearCurrent();
    } else {
      st.pos = st.match.index + Math.max(1, st.match[0].length);
    }
    this.stepShowNext();
  }

  /** 1件ずつ置換：今の箇所と、それより後ろの箇所をすべて置換して終える。 */
  stepReplaceRest() {
    const st = this.m_step;
    if (!st || !st.match) return;
    const repl = this.el.replacement.value;
    const useRegex = this.el.regex.checked;
    if (!st.folder) {
      const t = st.target;
      const matches = t.find(st.re);
      const i = matches.findIndex((x) => t.same(x, st.match));
      const rest = matches.slice(Math.max(0, i));
      t.replace(rest.map((x) => ({ match: x, text: expandReplacement(x.match, repl, useRegex) })));
      st.count += rest.length;
      this.finishStep();
      return;
    }
    const replaceText = useRegex ? repl : repl.replace(/\$/g, '$$$$');
    // 今のファイルは今の箇所から後ろ、それ以降のファイルは全体を置換する
    let start = st.match.index;
    while (st.fileIndex < st.files.length) {
      const f = st.files[st.fileIndex];
      const tail = f.text.slice(start);
      const count = findAllIn(tail, st.re).length;
      if (count) {
        f.text = f.text.slice(0, start) + tail.replace(st.re, replaceText);
        st.changed = true;
        st.count += count;
      }
      st.match = null;
      start = 0;
      this.stepNextFile();
    }
    this.finishStep();
  }

  /** 1件ずつ置換を終える（結果を表示する）。 */
  finishStep() {
    const st = this.m_step;
    if (!st) return;
    if (st.folder && st.fileIndex < st.files.length) this.stepNextFile();
    this.m_step = null;
    this.el.step.hidden = true;
    this.afterReplace();
    if (!st.folder) {
      this.setStatus(st.count
        ? `${st.count} 件を置換しました（現在のファイルに直接反映されました。保存するまでファイルには書き出されません）。`
        : '見つかりませんでした。');
    } else {
      this.setStatus(st.count
        ? `${st.count} 件を置換しました（${st.touched} 個のファイル、保存するまでファイルには反映されません）。`
        : '見つかりませんでした。');
    }
  }

  /** 1件ずつ置換の途中なら、ここまでの置換を反映して、メッセージを出さずに終える。 */
  endStepSilently() {
    const st = this.m_step;
    if (!st) return;
    if (st.folder && st.fileIndex < st.files.length) this.stepNextFile();
    this.m_step = null;
    this.el.step.hidden = true;
  }

  // ===== 文書の変化への対応（main.js から呼ぶ）=====

  /** ファイルを開いた・読み直した・表示のモードを切り替えた時：パネルを開いていれば、新しい内容で色を付け直す。 */
  onDocumentLoaded() {
    this.clearHighlights();
    if (!this.isOpen) return;
    if (this.m_step && !this.m_step.folder) this.endStepSilently();
    const re = this.el.query.value ? this.buildRegex() : null;
    if (re) this.target.highlight(this.target.find(re));
  }

  /** 文書を編集した時：少し待ってから色を付け直す（今の箇所は、まだ残っていれば残す）。 */
  onDocumentChanged() {
    if (!this.isOpen || !this.el.query.value) return;
    clearTimeout(this.m_rehighlightTimer);
    this.m_rehighlightTimer = setTimeout(() => {
      const re = this.buildRegex();
      if (!re) return;
      const t = this.target;
      t.dropStaleCurrent();
      t.highlight(t.find(re));
    }, 300);
  }
}
