// mdew：画面全体の動きと、C# 側ホスト（WebView2）とのやり取り。
//
// ホストとのメッセージ（JSON）:
//   web → host : {cmd:'ready'} / {cmd:'open', newWindow} / {cmd:'save', markdown, saveAs, images} /
//                {cmd:'dirty', value} / {cmd:'newWindow'} / {cmd:'pasteImage', id, type, data} / {cmd:'imeOn'} /
//                {cmd:'openUrl', url} / {cmd:'openRelative', path} / {cmd:'devTools'} / {cmd:'about'} /
//                {cmd:'openFolder', relPath, newWindow} / {cmd:'listDir', path} / {cmd:'openPath', path} /
//                {cmd:'readFolderFiles', reqId, root} / {cmd:'saveAll', files:[{path, markdown, images, current}]} /
//                {cmd:'openFind'} / {cmd:'findUpdate', status | results, selectedIndex | step} /
//                {cmd:'openImage', src} / {cmd:'exportPdf', name} / {cmd:'pdfMargin'} /
//                {cmd:'openRecent', path, newWindow} / {cmd:'clearRecent'} / {cmd:'openRecentFolder', path, relPath, newWindow} /
//                {cmd:'clearRecentFolders'} / {cmd:'close'} / {cmd:'openReadme'} /
//                {cmd:'copyHtml', html, text} / {cmd:'importImages', id, srcs} /
//                {cmd:'tableSizeDialog'} / {cmd:'linkDialog'} /
//                {cmd:'showMenu', name, x, y, items, buttons, keyboard}
//   host → web : {cmd:'load', path, name, docBase, markdown} /
//                {cmd:'saved', path, name, docBase, markdown, replacements} /
//                {cmd:'imagePasted', id, url, alt} / {cmd:'error', message} / {cmd:'focus'} / {cmd:'init', debug, tempDir} /
//                {cmd:'folderOpened', root, name} / {cmd:'dirList', path, dirs, files} /
//                {cmd:'folderFiles', reqId, files:[{path, text}]} / {cmd:'savedAll', saved, failed:[{path, message}]} /
//                {cmd:'findCommand', action, query, replacement, folder, matchCase, regex, index} /
//                {cmd:'pdfExported', ok} / {cmd:'recentFiles', files, folders} / {cmd:'imagesImported', id, urls} /
//                {cmd:'tableSize', rows, cols} / {cmd:'linkUrl', url} /
//                {cmd:'menuSelected', id} / {cmd:'menuClosed', name} / {cmd:'menuSwitch', name, keyboard}
import { Editor, showMenu, closeMenu } from './editor.js';
import { setJoinSoftBreaks, parseBlocks, renderBlock, imageSource } from './markdown.js';
import { FolderView, pathKey } from './folder.js';
import { FindEngine } from './find.js';
import { setHostClipboardWriter } from './clipboard.js';

/** ホスト（WebView2）とのやり取りの窓口。ブラウザ単体で開いた場合（動作確認用）は null。 */
const host = window.chrome?.webview ?? null;

/**
 * id で要素を取得する。
 * @param {string} a_id 要素の id
 * @returns {HTMLElement}
 */
const $ = (a_id) => document.getElementById(a_id);

/** 画面全体の状態。 */
const state = {
  path: null, // 開いているファイルのパス（新規は null）
  name: '無題', // タイトルバー等に表示するファイル名
  dirty: false, // 保存していない変更があるか
  pendingSave: null, // 保存要求中の内容（保存完了時に元テキストとして取り込み直す）
  nextImageId: 1, // 貼り付けた画像の番号（ホストからの imagePasted と対応させる）
  sourceMode: false, // ソースモード（Markdown のソースを直接編集する）か。終了時には覚えない
  tempDir: null, // 貼り付けた画像の一時フォルダ（ホストから init で届く。他のアプリへのコピーで使う）
  recentFiles: [], // 最近使ったファイル（フルパス。先頭が最新。ホストから recentFiles で届く）
  recentFolders: [], // 最近使ったフォルダ（フルパス。先頭が最新。ホストから recentFiles で届く）
};

/**
 * ホストにメッセージを送る（ブラウザ単体の場合は何もしない）。
 * @param {object} a_msg メッセージ（cmd と、cmd ごとの値。冒頭のコメント参照）
 */
function send(a_msg) {
  if (host) host.postMessage(JSON.stringify(a_msg));
}

/** 編集部分（editor.js）。変更・画像の貼り付け・リンクの操作は、ここで受け取ってホストとやり取りする。 */
/** 右クリックの「表を挿入…」で、表を置く位置（右クリックした段落を含む最上位のブロック。ホストの tableSize を待つ間だけ）。 */
let tableAnchor = null;
/** 右クリックの「リンクにする…」で、リンクにする選択範囲（ホストの linkUrl を待つ間だけ）。 */
let linkRange = null;
const editor = new Editor($('doc'), {
  onChange: () => {
    setDirty(true);
    scheduleOutline();
    findEngine.onDocumentChanged();
  },
  onOpenLink: (a_href) => openLink(a_href),
  onError: (a_message) => alert(a_message),
  onHoverLink: (a_href) => {
    $('status-link').textContent = a_href ? `クリックで開く：${a_href}` : '';
  },
  onOpenImage: (a_src) => {
    if (a_src) send({ cmd: 'openImage', src: a_src });
  },
  imageFileUrl: (a_img) => imageFileUrl(a_img),
  importImages: (a_srcs) => importImages(a_srcs),
  // 右クリックの「表を挿入…」：行数・列数のダイアログはホスト側（dialog\TableSizeDialog）で出す。挿入する位置は、
  // 結果（tableSize）が届くまで覚えておく。ブラウザ単体で開いた時（動作確認用）は 3行×3列で挿入する
  onInsertTable: (a_anchor) => {
    if (!host) {
      editor.insertTable(a_anchor, 3, 3);
      return;
    }
    tableAnchor = a_anchor;
    send({ cmd: 'tableSizeDialog' });
  },
  // 右クリックの「リンクにする…」：URL を入力するダイアログはホスト側（dialog\LinkInputDialog）で出す。選んでいた範囲は、
  // 結果（linkUrl）が届くまで覚えておく。ブラウザ単体で開いた時（動作確認用）は prompt で聞く
  onMakeLink: (a_range) => {
    if (!host) {
      const url = (prompt('リンク先のURLを入力してください') || '').trim();
      if (url) editor.makeLink(a_range, url);
      return;
    }
    linkRange = a_range;
    send({ cmd: 'linkDialog' });
  },
  // 右クリックの「ページトップに戻る」
  onPageTop: () => scrollToPageTop(),
  // 右クリックの「ソースモードに切り替え」
  onToggleSource: () => setSourceMode(true),
  onPasteImage: (a_file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).replace(/^data:[^,]*,/, '');
      send({ cmd: 'pasteImage', id: state.nextImageId++, type: a_file.type, data });
    };
    reader.readAsDataURL(a_file);
  },
});

/** 画像のコピーを頼んで、結果を待っている要求（番号 → resolve）。 */
const importWaiters = new Map();
let nextImportId = 1;

/**
 * 他のアプリが置いた画像のファイル（Excel の一時ファイル等。file:///…）を、貼り付けた画像と同じ一時フォルダへ
 * ホストにコピーしてもらう（保存する時に「<ファイル名>.images」へ移る）。
 * @param {string[]} a_srcs 画像の参照先
 * @returns {Promise<(string|null)[]>} それぞれの画像の URL（https://tmp.mdew/…。コピーできなければ null）
 */
function importImages(a_srcs) {
  if (!host) return Promise.resolve(a_srcs.map(() => null));
  const id = nextImportId++;
  return new Promise((resolve) => {
    importWaiters.set(id, resolve);
    send({ cmd: 'importImages', id, srcs: a_srcs });
  });
}

// 「Excel用にコピー」「表をコピー」は、ホストがクリップボードに書き込む（clipboard.js の setHostClipboardWriter）
if (host) setHostClipboardWriter((a_data) => send({ cmd: 'copyHtml', html: a_data.html, text: a_data.text }));

/**
 * パスを file:/// の URL にする（C:\dir\a b.png → file:///C:/dir/a%20b.png、\\server\share\a.png → file://server/share/a.png）。
 * @param {string} a_path Windows のパス
 * @returns {string}
 */
function toFileUrl(a_path) {
  const unc = /^[\\/]{2}/.test(a_path);
  const parts = a_path.replace(/^[\\/]+/, '').split(/[\\/]+/).map((p, k) =>
    (0 === k && /^[a-zA-Z]:$/.test(p) ? p : encodeURIComponent(p)));
  return `${unc ? 'file://' : 'file:///'}${parts.join('/')}`;
}

/**
 * フォルダのパスと相対パスをつなぐ（「.」「..」を解決する）。
 * @param {string} a_dir フォルダのパス
 * @param {string} a_rel 相対パス（区切りは / か \）
 * @returns {string}
 */
function joinPath(a_dir, a_rel) {
  const prefix = /^[\\/]{2}/.test(a_dir) ? '\\\\' : ''; // \\server\share
  const parts = a_dir.split(/[\\/]+/).filter(Boolean);
  for (const p of a_rel.split(/[\\/]+/)) {
    if ('..' === p) { if (parts.length > 1) parts.pop(); } else if (p && '.' !== p) parts.push(p);
  }
  return prefix + parts.join('\\');
}

/**
 * 画像のファイルの場所（他のアプリへコピーする時に、HTML の画像の参照先にする。mde と同じく file:/// の URL）。
 * http・https の画像はそのまま。貼り付けた画像（まだ保存していない）は一時フォルダのファイル、相対パスは開いている
 * ファイルのフォルダ基準。分からない場合（保存していない文書の相対パス、data: 等）は null。
 * @param {HTMLImageElement} a_img 画像
 * @returns {string|null}
 */
function imageFileUrl(a_img) {
  const raw = imageSource(a_img).trim();
  if (!raw) return null;
  const tmp = raw.match(/^https:\/\/tmp\.mdew\/([^?#]+)/i);
  if (tmp) return state.tempDir ? toFileUrl(joinPath(state.tempDir, decodeURIComponentSafe(tmp[1]))) : null;
  if (/^https?:/i.test(raw) || /^file:/i.test(raw)) return raw;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) return toFileUrl(raw);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//') || !state.path) return null;
  return toFileUrl(joinPath(state.path.replace(/[\\/][^\\/]*$/, ''), decodeURIComponentSafe(raw.split(/[?#]/)[0])));
}

/**
 * 画像など文書内の相対パスを、開いているファイルのフォルダ基準で解決させる
 * （ホストが渡す docBase への要求は、ホストがそのフォルダから画像を読んで返す）。
 * @param {string|null} a_docBase 基準の URL（https://doc.mdew/<世代>/）。無ければ画面自身の場所
 */
function setDocumentBase(a_docBase) {
  let base = document.querySelector('base');
  if (!base) {
    base = document.createElement('base');
    document.head.prepend(base);
  }
  base.href = a_docBase || location.href;
}

/**
 * 未保存の状態を変える（ステータスバー・タイトルを更新し、閉じる時の確認のためホストにも知らせる）。
 * @param {boolean} a_value 保存していない変更があるか
 */
function setDirty(a_value) {
  if (state.dirty === a_value) return;
  state.dirty = a_value;
  $('status-dirty').textContent = a_value ? '● 未保存' : '';
  updateTitle();
  syncDirtyToHost();
  folderView.refresh();
}

// ---- 保存していない、開いていないファイルの内容（フォルダビューでの切り替え・フォルダ全体の置換）----
/**
 * フォルダを開いている時に、保存せずに別のファイルへ切り替えたファイルや、フォルダ全体の置換で書き換えたファイルの
 * 内容（mde と同じく、保存するまでファイルには書き出さない）。パスのキー（pathKey）→ {path, markdown, images}。
 * そのファイルを開き直すと、この内容を表示する（未保存のまま）。「すべて保存」で書き出す。
 */
const pendingEdits = new Map();

/** 保存していない変更が、どこかにあるか（開いているファイル・開いていないファイル）。 */
function hasUnsaved() {
  return state.dirty || pendingEdits.size > 0;
}
/** 閉じる時の確認のため、保存していない変更があるかをホストに知らせる。 */
function syncDirtyToHost() {
  send({ cmd: 'dirty', value: hasUnsaved() });
}
/**
 * そのファイルに保存していない変更があるか（フォルダビューの「* 」に使う）。
 * @param {string} a_path ファイルのパス
 * @returns {boolean}
 */
function isPathDirty(a_path) {
  if (state.path && pathKey(a_path) === pathKey(state.path)) return state.dirty;
  return pendingEdits.has(pathKey(a_path));
}
/**
 * 開いていないファイルの内容を、保存せずに置いておく（フォルダ全体の置換）。
 * @param {string} a_path ファイルのパス
 * @param {string} a_markdown 内容
 */
function setPendingText(a_path, a_markdown) {
  const old = pendingEdits.get(pathKey(a_path));
  pendingEdits.set(pathKey(a_path), { path: a_path, markdown: a_markdown, images: old ? old.images : [] });
  folderView.refresh();
  syncDirtyToHost();
}
/**
 * 開いているファイルの内容を置き換える（すべて置換）。表示の位置は保ち、未保存にする。元に戻すの履歴は消える。
 * @param {string} a_markdown 置き換える内容
 */
function replaceCurrentMarkdown(a_markdown) {
  if (state.sourceMode) {
    // ソースモード：入力欄の内容を置き換える（入力欄の「元に戻す」で戻せる）
    replaceSourceRange(0, sourceArea.value.length, a_markdown);
    return;
  }
  const wrap = $('editor-wrap');
  const scrollTop = wrap.scrollTop;
  loadDocument(a_markdown);
  setDirty(true);
  wrap.scrollTop = scrollTop;
}

/** ウィンドウのタイトルを更新する（未保存なら先頭に「* 」）。 */
function updateTitle() {
  // ホスト側で、この後ろにアプリ名とバージョンを付けてタイトルバーに表示する（Program.cs の DocumentTitleChanged）
  document.title = `${state.dirty ? '* ' : ''}${state.name}`;
}

// ---- アウトライン（見出し一覧）----------------------------------------------
let outlineTimer = 0;

/** 入力のたびに作り直さないよう、入力が止まって 0.3 秒後にアウトラインを作り直す。 */
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(buildOutline, 300);
}
/** アウトラインの項目（見出しの要素 → li）。検索で見つかった見出しに印を付けるのに使う。 */
let outlineItems = new Map();
/** 検索で見つかった箇所を含む見出しと、今の箇所の見出し（find.js の updateOutlineMarks が決める）。 */
let outlineMarks = { hits: new Set(), current: null };

/**
 * アウトラインの見出しに、検索の印を付ける。
 * @param {Set<Element>} a_hits 見つかった箇所を含む見出し（黄色）
 * @param {Element|null} a_current 今の箇所の見出し（選択した色）
 */
function setOutlineMarks(a_hits, a_current) {
  outlineMarks = { hits: a_hits, current: a_current };
  applyOutlineMarks();
}
/** アウトラインの各項目に、検索の印を付け直す。 */
function applyOutlineMarks() {
  for (const [h, li] of outlineItems) {
    li.classList.toggle('search-hit', outlineMarks.hits.has(h));
    li.classList.toggle('search-current', outlineMarks.current === h);
  }
}

/**
 * アウトラインで折りたたんでいる見出し（見出しのレベル・文字・同じ見出しの何番目か、から作るキー）。
 * 入力のたびにアウトラインを作り直しても、ソースモードに切り替えても、折りたたんだままにするため。
 */
const collapsedOutline = new Set();

/** アウトラインを作り直す（見出しをクリックすると、その見出しへ移動する）。 */
function buildOutline() {
  if (state.sourceMode) {
    buildSourceOutline();
    return;
  }
  renderOutline(editor.headings().map((h) => ({
    level: Number(h.tagName.substring(1)),
    text: h.textContent.replace(/\u200b/g, '').trim(),
    heading: h,
    jump: () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }),
  })));
  applyOutlineMarks();
}

/**
 * アウトラインの一覧を作る。下のレベルの見出しを持つ見出しには「▸／▾」を付け、クリックで折りたたむ・広げる
 * （フォルダビューと同じ。mde のアウトラインと同じく、見出しの階層で折りたたむ）。見出しの文字をクリックすると、
 * その見出しへ移動する。
 * @param {{level:number, text:string, heading?:Element, jump:function}[]} a_entries 見出し（文書の順）
 */
function renderOutline(a_entries) {
  const list = $('outline-list');
  list.replaceChildren();
  outlineItems = new Map();
  const counts = new Map();
  // 開いている祖先の見出し（レベルと折りたたんでいるか）。折りたたんだ見出しの下の見出しは表示しない
  const ancestors = [];
  a_entries.forEach((entry, i) => {
    const name = entry.text || '(無題)';
    const base = `${entry.level}\t${name}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    const key = `${base}\t${n}`;
    while (ancestors.length && ancestors[ancestors.length - 1].level >= entry.level) ancestors.pop();
    const hasChildren = i + 1 < a_entries.length && a_entries[i + 1].level > entry.level;
    const collapsed = hasChildren && collapsedOutline.has(key);
    const li = document.createElement('li');
    li.className = `lv${entry.level}`;
    li.title = name; // 幅が足りずに見切れた時も、マウスを乗せれば全体が見えるように
    li.hidden = ancestors.some((a) => a.collapsed);
    const toggle = li.appendChild(document.createElement('span'));
    toggle.className = 'toggle';
    if (hasChildren) {
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.title = collapsed ? '広げる' : '折りたたむ';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsed) collapsedOutline.delete(key);
        else collapsedOutline.add(key);
        buildOutline();
      });
    }
    li.appendChild(document.createElement('span')).textContent = name;
    li.addEventListener('click', entry.jump);
    if (entry.heading) outlineItems.set(entry.heading, li);
    list.appendChild(li);
    ancestors.push({ level: entry.level, collapsed });
  });
}

// ---- リンクを開く ------------------------------------------------------------
/**
 * クリックされたリンクを開く。
 *  - 「#見出し」：文書内の見出しへ移動する
 *  - http(s)・mailto：既定のブラウザ・メールソフトで開く（ホストに依頼）
 *  - 相対パスの .md ファイル：このウィンドウで開く（ホストに依頼）
 * @param {string} a_href リンクの href 属性の値
 */
function openLink(a_href) {
  if (a_href.startsWith('#')) {
    jumpToHeading(a_href.slice(1));
    return;
  }
  if (/^(https?:|mailto:)/i.test(a_href)) {
    send({ cmd: 'openUrl', url: a_href });
    return;
  }
  const path = a_href.split('#')[0];
  if (!/^[a-z][a-z0-9+.-]*:/i.test(a_href) && /\.(md|markdown)$/i.test(path)) {
    if (mustConfirmDiscard() && !confirm('保存されていない変更があります。破棄してリンク先のファイルを開きますか？')) return;
    send({ cmd: 'openRelative', path: decodeURIComponentSafe(path) });
    return;
  }
  alert(`このリンクは開けません。\n${a_href}`);
}

/**
 * URL エンコードされた文字列（%E8%A6%8B 等）を元に戻す。正しくエンコードされていない場合はそのまま返す。
 * @param {string} a_text 文字列
 * @returns {string}
 */
function decodeURIComponentSafe(a_text) {
  try {
    return decodeURIComponent(a_text);
  } catch {
    return a_text;
  }
}

/**
 * 見出しの文字から、リンク先の名前（#以降）を作る。GitHub 等と同じ規則：
 * 英字は小文字にし、記号（句読点・括弧等）を除き、空白を「-」にする。同じ名前の見出しには -1, -2… を付ける
 * （-1, -2… は jumpToHeading 側で付ける）。
 * @param {string} a_text 見出しの文字
 * @returns {string}
 */
function slugify(a_text) {
  return a_text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

/**
 * 「#見出し」のリンク先の見出しへ移動し、見出しの先頭にカーソルを置く。
 * @param {string} a_fragment リンクの # より後ろ（URL エンコードされていてもよい）
 */
function jumpToHeading(a_fragment) {
  const h = findHeading(editor.headings(), a_fragment);
  if (!h) {
    alert(`リンク先の見出しが見つかりません。\n#${a_fragment}`);
    return;
  }
  h.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const range = document.createRange();
  range.setStart(h, 0);
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

/**
 * 「#見出し」のリンク先の見出しを探す（GitHub と同じ形の名前か、見出しの文字そのものと比べる。同じ名前の見出しが
 * 複数ある場合は、2つ目以降は「名前-1」「名前-2」…）。
 * @param {Element[]} a_headings 文書の見出し（文書の順）
 * @param {string} a_fragment リンクの # より後ろ（URL エンコードされていてもよい）
 * @returns {Element|null}
 */
function findHeading(a_headings, a_fragment) {
  const target = decodeURIComponentSafe(a_fragment).toLowerCase();
  const used = new Map();
  for (const h of a_headings) {
    const base = slugify(h.textContent.replace(/\u200b/g, ''));
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    const slug = 0 === count ? base : `${base}-${count}`;
    if (slug === target || h.textContent.trim().toLowerCase() === target) return h;
  }
  return null;
}

// ---- アウトラインの幅（境界をドラッグして変更。次回起動時も同じ幅にする）-----
const OUTLINE_WIDTH_KEY = 'outlineWidth';
const OUTLINE_DEFAULT_WIDTH = 220;

/**
 * アウトラインの幅を変える（120px 以上、画面の幅の 6 割以下に収める）。
 * @param {number} a_px 幅（px）
 * @returns {number} 実際に設定した幅
 */
function setOutlineWidth(a_px) {
  const width = Math.round(Math.max(120, Math.min(a_px, window.innerWidth * 0.6)));
  $('outline').style.width = `${width}px`;
  return width;
}
/**
 * アウトラインの幅を、次回起動時のために保存する（WebView2 の localStorage）。
 * @param {number} a_px 幅（px）
 */
function saveOutlineWidth(a_px) {
  try {
    localStorage.setItem(OUTLINE_WIDTH_KEY, String(a_px));
  } catch {
    // 保存できなくても動作には影響しない（次回は既定の幅になるだけ）
  }
}
// 前回のアウトラインの幅を復元する
try {
  const saved = Number(localStorage.getItem(OUTLINE_WIDTH_KEY));
  if (saved > 0) setOutlineWidth(saved);
} catch {
  // 読み込めなければ既定の幅のまま
}
/**
 * ペインの境界をドラッグして、ペインの幅を変えられるようにする（離した時に保存する。ダブルクリックで既定の幅に戻す）。
 * @param {HTMLElement} a_splitter 境界の要素
 * @param {HTMLElement} a_pane 幅を変えるペイン（境界の左側）
 * @param {(px: number) => number} a_setWidth 幅を設定する関数（実際に設定した幅を返す）
 * @param {(px: number) => void} a_saveWidth 幅を保存する関数
 * @param {number} a_defaultWidth 既定の幅
 */
function setupSplitter(a_splitter, a_pane, a_setWidth, a_saveWidth, a_defaultWidth) {
  a_splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    a_splitter.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = a_pane.getBoundingClientRect().width;
    let width = startWidth;
    document.body.classList.add('resizing');
    const onMove = (ev) => { width = a_setWidth(startWidth + ev.clientX - startX); };
    const onUp = () => {
      a_splitter.removeEventListener('pointermove', onMove);
      a_splitter.removeEventListener('pointerup', onUp);
      a_splitter.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('resizing');
      a_saveWidth(width);
    };
    a_splitter.addEventListener('pointermove', onMove);
    a_splitter.addEventListener('pointerup', onUp);
    a_splitter.addEventListener('pointercancel', onUp);
  });
  a_splitter.addEventListener('dblclick', () => a_saveWidth(a_setWidth(a_defaultWidth)));
}
setupSplitter($('splitter'), $('outline'), setOutlineWidth, saveOutlineWidth, OUTLINE_DEFAULT_WIDTH);

// ---- フォルダビューの幅（アウトラインと同じ。既定は mde と同じ 200px）-----------------
const FOLDER_WIDTH_KEY = 'folderWidth';
const FOLDER_DEFAULT_WIDTH = 200;
/**
 * フォルダビューの幅を変える（120px 以上、画面の幅の 6 割以下に収める）。
 * @param {number} a_px 幅（px）
 * @returns {number} 実際に設定した幅
 */
function setFolderWidth(a_px) {
  const width = Math.round(Math.max(120, Math.min(a_px, window.innerWidth * 0.6)));
  $('folder').style.width = `${width}px`;
  return width;
}
/**
 * フォルダビューの幅を、次回起動時のために保存する。
 * @param {number} a_px 幅（px）
 */
function saveFolderWidth(a_px) {
  try {
    localStorage.setItem(FOLDER_WIDTH_KEY, String(a_px));
  } catch {
    // 保存できなくても動作には影響しない
  }
}
try {
  const saved = Number(localStorage.getItem(FOLDER_WIDTH_KEY));
  if (saved > 0) setFolderWidth(saved);
} catch {
  // 読み込めなければ既定の幅のまま
}
setupSplitter($('folder-splitter'), $('folder'), setFolderWidth, saveFolderWidth, FOLDER_DEFAULT_WIDTH);

// ---- フォルダビュー（メニュー「ファイル」→「フォルダを開く...」で開いた時だけ表示する。folder.js）----
/** フォルダの中身の一覧を待っている要求（パスのキー → 結果を受け取る関数の配列）。 */
const dirListWaiters = new Map();
/**
 * フォルダの中身（サブフォルダ・Markdown ファイル）をホストに問い合わせる。
 * @param {string} a_path フォルダのパス
 * @returns {Promise<{dirs: string[], files: string[]}>}
 */
function listDir(a_path) {
  if (!host) return Promise.resolve({ dirs: [], files: [] });
  return new Promise((resolve) => {
    const key = pathKey(a_path);
    if (!dirListWaiters.has(key)) dirListWaiters.set(key, []);
    dirListWaiters.get(key).push(resolve);
    send({ cmd: 'listDir', path: a_path });
  });
}
const folderView = new FolderView($('folder-tree'), {
  onOpenFile: (a_path) => openFile(a_path),
  listDir,
  isDirty: isPathDirty,
});
$('folder-reopen').addEventListener('mousedown', (e) => e.preventDefault());
$('folder-reopen').addEventListener('click', () => doOpenFolder());

/**
 * ファイルを切り替える前に、今の文書の変更を破棄してよいか確認が要るか。フォルダを開いている時は、保存していない
 * 変更は破棄せずに置いておく（mde と同じ）ので、確認は要らない（ただし新規の文書は置いておけないので確認する）。
 * @returns {boolean}
 */
function mustConfirmDiscard() {
  return state.dirty && (!state.path || !folderView.isOpen);
}

/** ファイルを開くのを待っている要求（{key, resolve}。開いたら true、開けなかったら false を渡す）。 */
let openWaiter = null;
/**
 * パスを指定してファイルを開く（フォルダビュー・検索結果から）。今のファイルの保存していない変更は置いておく。
 * @param {string} a_path ファイルのパス
 * @returns {Promise<boolean>} 開けたら true
 */
function openFile(a_path) {
  if (state.path && pathKey(a_path) === pathKey(state.path)) return Promise.resolve(true);
  if (mustConfirmDiscard() && !confirm('保存されていない変更があります。破棄して別のファイルを開きますか？')) {
    return Promise.resolve(false);
  }
  if (!host) return Promise.resolve(false);
  if (openWaiter) openWaiter.resolve(false);
  return new Promise((resolve) => {
    openWaiter = { key: pathKey(a_path), resolve };
    send({ cmd: 'openPath', path: a_path });
  });
}

/**
 * メニュー「ファイル」→「最近使ったファイル」の項目：そのファイルを開く（保存していない変更があれば、開くと同じく確認する）。
 * ファイルが無い場合は、ホストが知らせて一覧から消す。
 * @param {string} a_path ファイルのフルパス
 */
function openRecent(a_path) {
  if (state.path && pathKey(a_path) === pathKey(state.path)) return;
  if (opensInNewWindow()) { send({ cmd: 'openRecent', path: a_path, newWindow: true }); return; }
  if (mustConfirmDiscard() && !confirm('保存されていない変更があります。破棄して別のファイルを開きますか？')) return;
  send({ cmd: 'openRecent', path: a_path });
}

/**
 * メニュー「ファイル」→「最近使ったフォルダ」の項目：そのフォルダを開く（「フォルダを開く...」と同じく、保存していない
 * 変更があれば確認する）。フォルダが無い場合は、ホストが知らせて一覧から消す。
 * @param {string} a_path フォルダのフルパス
 */
function openRecentFolder(a_path) {
  // このウィンドウで既に開いているフォルダなら、何もしない（同じフォルダを2つのウィンドウで開かないように）
  if (folderView.isOpen && pathKey(a_path) === pathKey(folderView.rootPath)) return;
  if (opensInNewWindow()) { send({ cmd: 'openRecentFolder', path: a_path, newWindow: true }); return; }
  if (hasUnsaved() && !confirm('保存されていない変更があります。破棄して別のフォルダを開きますか？')) return;
  send({ cmd: 'openRecentFolder', path: a_path, relPath: folderView.relativePath(state.path) });
}

/**
 * メニュー「ファイル」→「フォルダを開く...」・フォルダビューの「…」ボタン：保存していない変更があれば確認してから、
 * フォルダを選ぶダイアログを出してもらう。
 * @param {boolean} [a_fromMenu] メニューからか（メニューからの時だけ、opensInNewWindow なら新しいウィンドウで開く。
 *   フォルダビューの「…」ボタンは、このウィンドウのフォルダを切り替える）
 */
function doOpenFolder(a_fromMenu = false) {
  if (a_fromMenu && opensInNewWindow()) { send({ cmd: 'openFolder', newWindow: true }); return; }
  if (hasUnsaved() && !confirm('保存されていない変更があります。破棄して別のフォルダを開きますか？')) return;
  send({ cmd: 'openFolder', relPath: folderView.relativePath(state.path) });
}

/** フォルダ全体の検索の内容を待っている要求（番号 → 結果を受け取る関数）。 */
const folderFilesWaiters = new Map();
let nextFolderReqId = 1;
/**
 * フォルダ以下のすべての Markdown ファイルの今の内容を得る（開いているファイルは画面の内容、保存せずに置いてある
 * ファイルはその内容、それ以外はファイルの内容）。
 * @returns {Promise<{path: string, text: string}[]>}
 */
function folderFiles() {
  if (!host || !folderView.isOpen) return Promise.resolve([]);
  const reqId = nextFolderReqId++;
  return new Promise((resolve) => {
    folderFilesWaiters.set(reqId, resolve);
    send({ cmd: 'readFolderFiles', reqId, root: folderView.rootPath });
  }).then((a_files) => {
    const currentKey = state.path ? pathKey(state.path) : null;
    const currentText = currentKey ? currentMarkdown() : null;
    return a_files.map((f) => {
      const key = pathKey(f.path);
      if (key === currentKey) return { path: f.path, text: currentText };
      const p = pendingEdits.get(key);
      return p ? { path: f.path, text: p.markdown } : f;
    });
  });
}

/** メニュー「ファイル」→「すべて保存」：開いているファイルと、保存せずに置いてあるファイルをすべて保存する。 */
function doSaveAll() {
  const files = [];
  if (state.path && state.dirty) {
    if (state.sourceMode) {
      state.pendingSave = null;
      files.push({ path: state.path, markdown: sourceArea.value, images: imageSourcesIn(sourceArea.value), current: true });
    } else {
      const result = editor.serialize();
      state.pendingSave = result;
      files.push({ path: state.path, markdown: result.text, images: editor.collectImageSources(), current: true });
    }
  }
  for (const p of pendingEdits.values()) files.push({ path: p.path, markdown: p.markdown, images: p.images || [] });
  // 保存するものが無ければ何もしない（mde と同じ。新規の文書は対象外。「保存」で保存する）
  if (!files.length) return;
  if (!confirm('編集中のすべてのファイルを保存します。よろしいですか？')) {
    state.pendingSave = null;
    return;
  }
  send({ cmd: 'saveAll', files });
}

// ---- ソースモード（Markdown のソースを直接編集する。mde と同じ。メニュー「表示」→「ソースモード」）----
// 入力欄（textarea）で Markdown のソースをそのまま編集する。切り替えた時は、カーソルと表示の位置を、
// 同じ段落などのまとまりに合わせる（mde と同じく、まとまり単位のおおよその位置）。
// 入力欄の後ろに、同じ大きさ・同じ文字の配置の要素（#source-backdrop）を重ね、検索で見つかった箇所の色と、
// 行の位置を測るのに使う（入力欄の中の文字には色を付けられないため）。
const sourceArea = $('source');
const sourceBackdrop = $('source-backdrop');
/** ソースモードに切り替えた時（・読み込んだ時・保存した時）の入力欄の内容。変わっていなければ、戻る時に読み直さない。 */
let sourceOriginal = '';
/** ソースモード中に「段落中の改行」を切り替えた等で、戻る時に読み直しが要るか。 */
let sourceNeedsReload = false;
/** 後ろの要素の内容が、入力欄と合っていないか（入力するたびに作り直さず、使う時に作り直す）。 */
let sourceBackdropStale = true;
/** 検索で見つかった箇所（{start, end} の配列）と、今の箇所。 */
let sourceMarks = { matches: [], current: null };
/** ソースモードに切り替えた時の、各まとまりのソースの中の位置（変更せずに戻った時に使う）。 */
let sourcePositions = [];

/**
 * 開いているファイルの今の内容（Markdown）。ソースモードなら入力欄の内容。
 * @returns {string}
 */
function currentMarkdown() {
  return state.sourceMode ? sourceArea.value : editor.serialize().text;
}

/**
 * Markdown の中の画像の参照先を集める（ソースモードで保存する時に、名前を付けて保存で画像をコピーするため。
 * Markdown モードの editor.collectImageSources と同じ役目）。
 * @param {string} a_text Markdown
 * @returns {string[]}
 */
function imageSourcesIn(a_text) {
  const result = [];
  for (const m of a_text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))/g)) result.push(m[1] || m[2]);
  for (const m of a_text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) result.push(m[1]);
  return result;
}

/**
 * 入力欄の内容を置き換える（ファイルを読み込んだ時等。カーソルは先頭）。
 * @param {string} a_text 内容
 */
function setSourceText(a_text) {
  sourceArea.value = a_text;
  sourceOriginal = a_text;
  sourceNeedsReload = false;
  sourceMarks = { matches: [], current: null };
  sourceBackdropStale = true;
  sourceArea.setSelectionRange(0, 0);
  sourceArea.scrollTop = 0;
}

/**
 * HTML の特別な文字を文字参照にする（後ろの要素の内容を作る用）。
 * @param {string} a_text 文字列
 * @returns {string}
 */
function escapeSourceHtml(a_text) {
  return a_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 後ろの要素の内容を、入力欄の内容と検索の色に合わせて作り直す（1行を1つの span にする。行の位置を測るため）。 */
function renderSourceBackdrop() {
  const text = sourceArea.value;
  const { matches, current } = sourceMarks;
  const lines = text.split('\n');
  let html = '';
  let pos = 0;
  let mi = 0;
  for (let li = 0; li < lines.length; li++) {
    const ls = pos;
    const le = pos + lines[li].length;
    while (mi < matches.length && matches[mi].end <= ls) mi++;
    let inner = '';
    let p = ls;
    for (let k = mi; k < matches.length && matches[k].start < le; k++) {
      const s = Math.max(matches[k].start, ls);
      const e = Math.min(matches[k].end, le);
      if (e <= s) continue;
      const cls = current && matches[k].start === current.start ? ' class="current"' : '';
      inner += `${escapeSourceHtml(text.slice(p, s))}<mark${cls}>${escapeSourceHtml(text.slice(s, e))}</mark>`;
      p = e;
    }
    inner += escapeSourceHtml(text.slice(p, le));
    // 最後の行の後ろに空白を置く（末尾が改行の場合も、入力欄と同じ高さになるように）
    html += `<span data-s="${ls}">${inner}${li < lines.length - 1 ? '\n' : ' '}</span>`;
    pos = le + 1;
  }
  sourceBackdrop.innerHTML = html;
  sourceBackdrop.scrollTop = sourceArea.scrollTop;
  sourceBackdropStale = false;
}

/** 後ろの要素が古ければ作り直す。 */
function ensureSourceBackdrop() {
  if (sourceBackdropStale) renderSourceBackdrop();
}

/**
 * 検索で見つかった箇所に色を付ける（find.js の SourceTarget から呼ぶ）。
 * @param {{start: number, end: number}[]} a_matches 見つかった箇所
 * @param {{start: number, end: number}|null} a_current 今の箇所
 */
function highlightSource(a_matches, a_current) {
  sourceMarks = { matches: a_matches, current: a_current };
  renderSourceBackdrop();
}

/**
 * ソースの位置を含む行の、入力欄の中での上端の位置（px。スクロールしていない時の位置）。
 * @param {number} a_pos ソースの中の文字の位置
 * @returns {number}
 */
function sourceLineTop(a_pos) {
  ensureSourceBackdrop();
  let top = 0;
  for (const span of sourceBackdrop.children) {
    if (Number(span.dataset.s) > a_pos) break;
    top = span.offsetTop;
  }
  return top;
}

/**
 * 入力欄の一番上に見えている行の、ソースの中の位置。
 * @returns {number}
 */
function sourceTopVisibleOffset() {
  ensureSourceBackdrop();
  const pad = parseFloat(getComputedStyle(sourceArea).paddingTop) || 0;
  for (const span of sourceBackdrop.children) {
    if (span.offsetTop + span.offsetHeight > sourceArea.scrollTop + pad) return Number(span.dataset.s);
  }
  return 0;
}

/**
 * ソースの位置の行を、入力欄の一番上に表示する。
 * @param {number} a_pos ソースの中の文字の位置
 */
function scrollSourceToTop(a_pos) {
  const pad = parseFloat(getComputedStyle(sourceArea).paddingTop) || 0;
  sourceArea.scrollTop = Math.max(0, sourceLineTop(a_pos) - pad);
  sourceBackdrop.scrollTop = sourceArea.scrollTop;
}

/**
 * ソースの位置が見えていなければ、見える位置（上から 3 分の 1 あたり）までスクロールする（検索で使う）。
 * @param {number} a_pos ソースの中の文字の位置
 */
function revealSourcePosition(a_pos) {
  const top = sourceLineTop(a_pos);
  const view = sourceArea.clientHeight;
  if (top < sourceArea.scrollTop + 20 || top > sourceArea.scrollTop + view - 60) {
    sourceArea.scrollTop = Math.max(0, top - view / 3);
  }
  sourceBackdrop.scrollTop = sourceArea.scrollTop;
}

/**
 * 入力欄の一部を置き換える。入力欄の「元に戻す」（Ctrl+Z）で戻せるよう、入力欄への入力として行う
 * （置換で使う。フォーカスは元の場所に戻す）。
 * @param {number} a_start 置き換える範囲の始まり
 * @param {number} a_end 置き換える範囲の終わり
 * @param {string} a_text 置き換える文字
 */
function replaceSourceRange(a_start, a_end, a_text) {
  const active = document.activeElement;
  sourceArea.focus();
  sourceArea.setSelectionRange(a_start, a_end);
  if (a_text) document.execCommand('insertText', false, a_text);
  else document.execCommand('delete');
  if (active && active !== sourceArea) active.focus();
}

// 入力欄を編集したら未保存にし、アウトラインと検索の色を作り直す。スクロールは後ろの要素にも合わせる
sourceArea.addEventListener('input', () => {
  setDirty(true);
  sourceMarks = { matches: [], current: null };
  sourceBackdropStale = true;
  sourceBackdrop.textContent = '';
  scheduleOutline();
  findEngine.onDocumentChanged();
});
sourceArea.addEventListener('scroll', () => { sourceBackdrop.scrollTop = sourceArea.scrollTop; });

// ソースモードの右クリック：切り取り・コピー・貼り付け・すべて選択と、「Markdownモードに切り替え」（mde と同じ）
sourceArea.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hasSelection = sourceArea.selectionStart !== sourceArea.selectionEnd;
  showMenu(e.clientX, e.clientY, [
    { label: '切り取り', key: 'Ctrl+X', disabled: !hasSelection, run: () => document.execCommand('cut') },
    { label: 'コピー', key: 'Ctrl+C', disabled: !hasSelection, run: () => document.execCommand('copy') },
    { label: '貼り付け', key: 'Ctrl+V', run: () => pasteIntoSource() },
    null,
    { label: 'すべて選択', key: 'Ctrl+A', run: () => sourceArea.select() },
    null,
    { label: 'ページトップに戻る', run: () => scrollToPageTop() },
    { label: 'Markdownモードに切り替え', run: () => setSourceMode(false) },
  ], (a_item) => a_item.run());
});

/**
 * 右クリックの「ページトップに戻る」：文書の先頭を表示し、カーソルも先頭に置く（mde と同じ。カーソルを置かないと、
 * 続けて文字を打った時に元の位置へ戻ってしまうため）。ソースモードでは入力欄の先頭。
 */
function scrollToPageTop() {
  if (state.sourceMode) {
    sourceArea.focus();
    sourceArea.setSelectionRange(0, 0);
    sourceArea.scrollTop = 0;
    sourceBackdrop.scrollTop = 0;
    return;
  }
  editor.focus();
  editor.setCaret({ index: 0, offset: 0 });
  $('editor-wrap').scrollTop = 0;
}

/** ソースモードの右クリックの「貼り付け」：クリップボードの文字を、そのまま入力欄に貼る（元に戻せるよう、入力として入れる）。 */
async function pasteIntoSource() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    alert('クリップボードを読み取れませんでした。Ctrl+V で貼り付けてください。');
    return;
  }
  sourceArea.focus();
  if (text) document.execCommand('insertText', false, text);
}

/** ソースモードのアウトライン：ソースの見出しの行（# で始まる行。コードブロックの中は除く）の一覧。 */
function buildSourceOutline() {
  const entries = [];
  const text = sourceArea.value;
  let pos = 0;
  let fence = null;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
    if (!h) continue;
    entries.push({
      level: h[1].length,
      text: (h[2] || '').trim(),
      jump: () => {
        sourceArea.focus();
        sourceArea.setSelectionRange(start, start);
        scrollSourceToTop(start);
      },
    });
  }
  renderOutline(entries);
}

/**
 * まとまりの位置の一覧から、ソースの位置を含むまとまりの番号を探す。
 * @param {{start: number}[]} a_positions 各まとまりのソースの中の位置（文書の順）
 * @param {number} a_offset ソースの中の位置
 * @returns {number} まとまりの番号（無ければ -1）
 */
function blockIndexAt(a_positions, a_offset) {
  let found = -1;
  for (let i = 0; i < a_positions.length; i++) {
    if (a_positions[i].start <= a_offset) found = i;
    else break;
  }
  return found;
}

/**
 * ソースモードと Markdown モードを切り替える。未保存の印はそのまま残す。
 *  - ソースモードへ：今の内容を Markdown にして入力欄に表示する。カーソルのあったまとまりの先頭にカーソルを置き、
 *    一番上に見えていたまとまりを、入力欄でも一番上に表示する。
 *  - Markdown モードへ：入力欄の内容が変わっていれば、その内容で読み直す（変わっていなければ、元に戻すの履歴も
 *    そのまま残る）。カーソルと表示の位置は、入力欄で見ていた行のまとまりに合わせる。
 * @param {boolean} a_on ソースモードにするか
 */
function setSourceMode(a_on) {
  if (state.sourceMode === a_on) return;
  const wrap = $('editor-wrap');
  if (a_on) {
    const result = editor.serialize();
    const blocks = [...$('doc').children];
    const caret = editor.getCaret();
    const caretEl = caret ? blocks[caret.index] : null;
    const caretPos = result.positions.find((p) => p.el === caretEl);
    const wrapTop = wrap.getBoundingClientRect().top;
    const topPos = result.positions.find((p) => p.el.getBoundingClientRect().bottom > wrapTop + 1);
    state.sourceMode = true;
    document.body.classList.add('source-mode');
    setSourceText(result.text);
    sourcePositions = result.positions;
    sourceArea.focus();
    const at = caretPos ? caretPos.start : 0;
    sourceArea.setSelectionRange(at, at);
    if (topPos) scrollSourceToTop(topPos.start);
    buildOutline();
  } else {
    const text = sourceArea.value;
    const caretOffset = sourceArea.selectionStart;
    const topOffset = sourceTopVisibleOffset();
    const changed = text !== sourceOriginal || sourceNeedsReload;
    state.sourceMode = false;
    document.body.classList.remove('source-mode');
    let positions = sourcePositions;
    if (changed) {
      const wasDirty = state.dirty;
      editor.load(text);
      if (wasDirty) setDirty(true);
      positions = editor.serialize().positions;
    }
    buildOutline();
    const blocks = positions.map((p) => p.el);
    // 先にカーソルを置く（カーソルを置くと、その位置まで表示が動くため）。その後で、入力欄の一番上に見えていた
    // まとまりを、一番上に表示する（ソースモードへ切り替えた時と同じ順）
    editor.focus();
    const ci = blockIndexAt(positions, caretOffset);
    if (ci >= 0) editor.setCaret({ index: [...$('doc').children].indexOf(blocks[ci]), offset: 0 });
    const top = blockIndexAt(positions, topOffset);
    if (top >= 0) blocks[top].scrollIntoView({ block: 'start' });
    else wrap.scrollTop = 0;
  }
  findEngine.onDocumentLoaded();
}

// ---- 検索と置換（find.js）---------------------------------------------------------
const findEngine = new FindEngine({
  editor,
  doc: $('doc'),
  folder: folderView,
  currentPath: () => state.path,
  folderFiles,
  openFile,
  replaceCurrentMarkdown,
  setPendingText,
  setOutlineMarks,
  currentMarkdown,
  source: {
    active: () => state.sourceMode,
    area: sourceArea,
    highlight: (a_matches, a_current) => highlightSource(a_matches, a_current),
    reveal: (a_pos) => revealSourcePosition(a_pos),
    replaceRange: (a_start, a_end, a_text) => replaceSourceRange(a_start, a_end, a_text),
  },
  postToWindow: (a_update) => {
    if (host) send({ cmd: 'findUpdate', ...a_update });
    else findUpdates.push(a_update); // ブラウザ単体の自動テスト用
  },
});
/** ブラウザ単体の自動テストで、ウィンドウへ送るはずだった表示の更新を記録する。 */
const findUpdates = [];
/** 検索と置換のウィンドウを開く（ホスト側の dialog\FindReplaceWindow。開いていれば前に出す）。 */
function openFindWindow() {
  send({ cmd: 'openFind' });
}

// ---- コマンド ---------------------------------------------------------------
/**
 * 文書を表示し、未保存の印を消して、アウトラインを作り直す。
 * @param {string} a_markdown 文書の全体（新規は ''）
 */
function loadDocument(a_markdown) {
  editor.load(a_markdown);
  setDirty(false);
  if (state.sourceMode) {
    // ソースモードでは、入力欄にも同じ内容を表示する
    setSourceText(a_markdown);
    buildOutline();
    sourceArea.focus();
    return;
  }
  buildOutline();
  editor.focus();
}
/** 新規：新しいウィンドウを開く（今のウィンドウの内容はそのまま）。 */
function doNew() {
  send({ cmd: 'newWindow' });
}
/**
 * メニューからファイル・フォルダを開く時（開く・最近使ったファイル・フォルダを開く・最近使ったフォルダ）に、
 * 新しいウィンドウで開くか。フォルダを開いている時や、ファイルを開いている・何か書いてある時は、今の内容を
 * 残したまま別のウィンドウで開く。何も書いていない新規のウィンドウなら、このウィンドウで開く。
 * @returns {boolean}
 */
function opensInNewWindow() {
  return folderView.isOpen || !!state.path || '' !== currentMarkdown().trim();
}
/** 開く：ホストにファイルを開くダイアログを出してもらう（opensInNewWindow なら、選んだファイルを新しいウィンドウで
 * 開く。このウィンドウで開く時は、未保存の変更があれば先に確認する）。 */
function doOpen() {
  if (opensInNewWindow()) { send({ cmd: 'open', newWindow: true }); return; }
  if (mustConfirmDiscard() && !confirm('保存されていない変更があります。破棄して別のファイルを開きますか？')) return;
  send({ cmd: 'open' });
}
/**
 * 保存：内容を Markdown にしてホストに渡す。新規の文書は「名前を付けて保存」になる。
 * 保存が終わると、ホストから saved が届く。
 * @param {boolean} a_saveAs 名前を付けて保存か
 */
function doSave(a_saveAs) {
  if (state.sourceMode) {
    // ソースモード：入力欄の内容をそのまま保存する（saved を受け取った時に、編集部分も読み直す）
    state.pendingSave = null;
    const text = sourceArea.value;
    send({ cmd: 'save', markdown: text, saveAs: !!a_saveAs || !state.path, images: imageSourcesIn(text) });
    return;
  }
  const result = editor.serialize();
  state.pendingSave = result;
  send({ cmd: 'save', markdown: result.text, saveAs: !!a_saveAs || !state.path, images: editor.collectImageSources() });
}

/** PDF に書き出し中か（書き出しが終わるまで、次の書き出しを受け付けない）。 */
let exportingPdf = false;

/**
 * PDF に書き出す（mde のメニュー「PDFに書き出し…」）。今の内容（ソースモードなら入力欄の内容）を印刷用の要素
 * （#print-doc。見た目は app.css の @media print）に表示し、画像を読み終えてから、ホストに書き出してもらう
 * （保存先を選ぶダイアログ・A4・余白はホストが行う。Program.cs の ExportPdfAsync）。終わると pdfExported が届く。
 */
async function doExportPdf() {
  if (exportingPdf) return;
  const printDoc = $('print-doc');
  const markdown = currentMarkdown();
  printDoc.innerHTML = markdown ? parseBlocks(markdown).map(renderBlock).join('') : '';
  for (const box of printDoc.querySelectorAll('input')) box.disabled = true;
  linkPrintHeadings(printDoc);
  if (!host) {
    window.print(); // ブラウザ単体（動作確認用）
    printDoc.replaceChildren();
    return;
  }
  exportingPdf = true;
  await Promise.all([...printDoc.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  }))));
  send({ cmd: 'exportPdf', name: state.name });
}

/**
 * 印刷用の文書の「#見出し」のリンクを、PDF の中で見出しへ移動できるようにする。リンク先の見出しに id を付け、
 * リンクをその id にする（Chromium が PDF の中の移動先を作る。編集画面と同じく findHeading で見出しを探す）。
 * リンク先の見出しが無いリンクはそのまま。
 * @param {HTMLElement} a_printDoc 印刷用の文書（#print-doc）
 */
function linkPrintHeadings(a_printDoc) {
  const headings = [...a_printDoc.querySelectorAll(':scope > :is(h1, h2, h3, h4, h5, h6)')];
  for (const a of a_printDoc.querySelectorAll('a[href^="#"]')) {
    const h = findHeading(headings, a.getAttribute('href').slice(1));
    if (!h) continue;
    if (!h.id) h.id = `mdew-heading-${headings.indexOf(h) + 1}`;
    a.setAttribute('href', `#${h.id}`);
  }
}

/** メニューのボタン（data-cmd 属性）とコマンドの対応。 */
const commands = {
  new: doNew,
  open: doOpen,
  save: () => doSave(false),
  saveAs: () => doSave(true),
  openFolder: () => doOpenFolder(true),
  saveAll: doSaveAll,
  find: openFindWindow,
  exportPdf: doExportPdf,
  pdfMargin: () => send({ cmd: 'pdfMargin' }), // 余白の設定（ホスト側の dialog\PdfMarginDialog）
  clearRecent: () => send({ cmd: 'clearRecent' }),
  clearRecentFolders: () => send({ cmd: 'clearRecentFolders' }),
  close: () => send({ cmd: 'close' }), // このウィンドウを閉じる（保存していない変更があれば、ホストが確認する）
  toggleFolder: () => document.body.classList.toggle('no-folderpane'),
  toggleOutline: () => togglePane('no-outline'),
  toggleStatusbar: () => togglePane('no-statusbar'),
  softBreakSource: () => setSoftBreakMode(false),
  softBreakJoin: () => setSoftBreakMode(true),
  toggleSource: () => setSourceMode(!state.sourceMode),
  zoomIn: () => setZoom(zoomLevel + ZOOM_STEP),
  zoomOut: () => setZoom(zoomLevel - ZOOM_STEP),
  zoomReset: () => setZoom(1),
  about: () => send({ cmd: 'about' }), // バージョン情報のウィンドウ（ホスト側の dialog\AboutWindow）
  // Readme を開く（実行フォルダの README.md を新しいウィンドウで開く。ホスト側の OpenReadme）
  readme: () => send({ cmd: 'openReadme' }),
};
document.querySelectorAll('#menubar button[data-cmd]').forEach((b) =>
  b.addEventListener('click', () => commands[b.dataset.cmd]()));

// ---- アウトライン・ステータスバーの表示の切り替え（次回起動時も同じにする）---------
/** 表示しないペインを body に付けるクラス名の一覧（localStorage に保存するキー）。 */
const HIDDEN_PANES_KEY = 'hiddenPanes';
/** 表示を切り替えられるペイン（body に付けるクラス名。付いている時は表示しない）。 */
const PANE_CLASSES = ['no-outline', 'no-statusbar'];

/**
 * ペインの表示・非表示を切り替えて、次回起動時のために保存する（WebView2 の localStorage）。
 * @param {string} a_class body に付けるクラス名（no-outline：アウトライン、no-statusbar：ステータスバー）
 */
function togglePane(a_class) {
  document.body.classList.toggle(a_class);
  try {
    const hidden = PANE_CLASSES.filter((c) => document.body.classList.contains(c));
    localStorage.setItem(HIDDEN_PANES_KEY, JSON.stringify(hidden));
  } catch {
    // 保存できなくても動作には影響しない（次回はすべて表示になるだけ）
  }
}
/**
 * ペインが表示されているか（メニューの ✓ に使う）。
 * @param {string} a_class body に付けるクラス名
 * @returns {boolean}
 */
function isPaneVisible(a_class) {
  return !document.body.classList.contains(a_class);
}
/**
 * ステータスバーの「フォルダを隠す／表示」「アウトラインを隠す／表示」のボタンの文字を、今の表示に合わせる（mde と同じ）。
 * body のクラス（no-folderpane・no-outline）が変わるたびに呼ばれる（下の MutationObserver）。
 */
function updatePaneButtons() {
  $('status-folder').textContent = isPaneVisible('no-folderpane') ? 'フォルダを隠す' : 'フォルダを表示';
  $('status-outline').textContent = isPaneVisible('no-outline') ? 'アウトラインを隠す' : 'アウトラインを表示';
}
for (const [id, cmd] of [['status-folder', 'toggleFolder'], ['status-outline', 'toggleOutline']]) {
  // mousedown で既定の動作を止めて、編集中のカーソル位置を保つ
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
  $(id).addEventListener('click', () => commands[cmd]());
}
new MutationObserver(updatePaneButtons).observe(document.body, { attributes: true, attributeFilter: ['class'] });
// 前回の表示・非表示を復元する
try {
  const hidden = JSON.parse(localStorage.getItem(HIDDEN_PANES_KEY) || '[]');
  for (const c of hidden) if (PANE_CLASSES.includes(c)) document.body.classList.add(c);
} catch {
  // 読み込めなければ、すべて表示のまま
}

// ---- 段落中の改行の表示（mde のメニュー「表示」→「段落中の改行」と同じ。次回起動時も同じにする）----
/** localStorage に保存するキー（値は 'join'：空行が入るまで改行しない、'source'：ソースの通りに改行する）。 */
const SOFT_BREAK_KEY = 'softBreakMode';
/** 段落中の改行を、空行が入るまで改行しない表示にしているか（true が既定。false：ソースの通りに改行する）。 */
let joinSoftBreaks = true;

/**
 * 段落中の改行（空行を挟まない、ソースの単純な改行）の表示を切り替える。
 * 表示中の文書は、いったん Markdown に書き出してから読み直して反映する（mde と同じ方法）。
 * 未保存の印はそのまま残し、表示の位置（スクロール）も保つ。元に戻す（Ctrl+Z）の履歴は消える。
 * 保存する内容は、どちらの表示でも変わらない（改行は改行のまま保存する）。
 * @param {boolean} a_join true：空行が入るまで改行しない、false：ソースの通りに改行する
 */
function setSoftBreakMode(a_join) {
  if (joinSoftBreaks === a_join) return;
  joinSoftBreaks = a_join;
  try {
    localStorage.setItem(SOFT_BREAK_KEY, a_join ? 'join' : 'source');
  } catch {
    // 保存できなくても動作には影響しない（次回は既定の表示になるだけ）
  }
  if (state.sourceMode) {
    // ソースモード中は設定だけを変え、Markdown モードに戻る時に反映する（mde と同じ）
    setJoinSoftBreaks(a_join);
    sourceNeedsReload = true;
    return;
  }
  const markdown = editor.serialize().text;
  const wasDirty = state.dirty;
  const wrap = $('editor-wrap');
  const scrollTop = wrap.scrollTop;
  setJoinSoftBreaks(a_join);
  loadDocument(markdown);
  if (wasDirty) setDirty(true);
  wrap.scrollTop = scrollTop;
}
// 前回の表示を復元する（最初の文書を読み込む前に設定する）
try {
  // 保存されていなければ既定（空行が入るまで改行しない）
  joinSoftBreaks = 'source' !== localStorage.getItem(SOFT_BREAK_KEY);
} catch {
  // 読み込めなければ既定（空行が入るまで改行しない）のまま
}
setJoinSoftBreaks(joinSoftBreaks);

// ---- 表示倍率（mde のステータスバーの「－」「100%」「＋」と同じ。次回起動時も同じにする）----------
/** localStorage に保存するキー（値は倍率。1 が 100%）。 */
const ZOOM_KEY = 'zoom';
/** 1回の拡大・縮小で変える倍率（mde と同じ 10%）。 */
const ZOOM_STEP = 0.1;
/** 倍率の範囲（mde と同じ 50%〜250%）。 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
/** 今の表示倍率（1 が 100%）。 */
let zoomLevel = 1;

/**
 * 文書の表示倍率を変える（文書の部分だけ。メニュー・アウトライン等は変えない）。Markdown の表示は文書全体
 * （文字・画像・余白）を拡大・縮小し（app.css の #doc の zoom）、ソースモードは文字の大きさを変える。
 * 文書の中の今見ている位置は保つ。
 * @param {number} a_level 倍率（1 が 100%。50%〜250% に収め、1% 単位に丸める）
 */
function setZoom(a_level) {
  const level = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(a_level * 100) / 100));
  const wrap = $('editor-wrap');
  const ratio = wrap.scrollHeight > wrap.clientHeight ? wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight) : 0;
  zoomLevel = level;
  document.documentElement.style.setProperty('--zoom', String(level));
  if (wrap.scrollHeight > wrap.clientHeight) wrap.scrollTop = ratio * (wrap.scrollHeight - wrap.clientHeight);
  try {
    localStorage.setItem(ZOOM_KEY, String(level));
  } catch {
    // 保存できなくても動作には影響しない（次回は 100% になるだけ）
  }
}
// 前回の倍率を復元する
try {
  const saved = Number(localStorage.getItem(ZOOM_KEY));
  if (saved > 0) setZoom(saved);
} catch {
  // 読み込めなければ 100% のまま
}
// Ctrl+マウスホイールで拡大・縮小する（編集ペインの上で。mde と同じ。タッチパッドの2本指の操作のように少しずつ
// 届く場合は、ホイール1目盛り分（100）たまるごとに 10% ずつ変える）
let zoomWheelDelta = 0;
$('editor-wrap').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomWheelDelta += e.deltaY;
  if (Math.abs(zoomWheelDelta) < 50) return;
  setZoom(zoomLevel + (zoomWheelDelta < 0 ? ZOOM_STEP : -ZOOM_STEP));
  zoomWheelDelta = 0;
}, { passive: false });

// ---- メニューバーのメニュー（ファイル・表示）----------------------------------
/**
 * メニューバーのメニュー。button はメニューを開くボタン、key は Alt と一緒に押して開くキー、
 * items は項目を返す関数（開くたびに作る。✓ の状態を、その時の表示に合わせるため）。
 * 項目の key はショートカットの表示、checked は ✓ を付けるか、cmd は選んだ時に実行するコマンド（commands）、
 * heading は選べない見出し（下の項目のまとまりの名前。mde のサブメニューの名前に当たる）。
 */
const MENUS = {
  file: {
    button: $('menu-file'),
    key: 'f',
    items: () => [
      { label: '新規', key: 'Ctrl+N', cmd: 'new' },
      { label: '開く', key: 'Ctrl+O', cmd: 'open' },
      // 最近使ったファイル（mde と同じくサブメニュー。パスはフルパスで表示する）
      {
        label: '最近使ったファイル',
        submenu: state.recentFiles.length
          ? [...state.recentFiles.map((p) => ({ label: p, title: p, path: true, run: () => openRecent(p) })), null,
            { label: '履歴をクリア', cmd: 'clearRecent' }]
          : [{ label: '（履歴なし）', disabled: true }],
      },
      // 最近使ったフォルダ（「フォルダを開く...」で開いたフォルダ。パスはフルパスで表示する）
      {
        label: '最近使ったフォルダ',
        submenu: state.recentFolders.length
          ? [...state.recentFolders.map((p) => ({ label: p, title: p, path: true, run: () => openRecentFolder(p) })), null,
            { label: '履歴をクリア', cmd: 'clearRecentFolders' }]
          : [{ label: '（履歴なし）', disabled: true }],
      },
      { label: 'フォルダを開く...', cmd: 'openFolder' },
      null,
      { label: '保存', key: 'Ctrl+S', cmd: 'save' },
      { label: '名前を付けて保存', key: 'Ctrl+Shift+S', cmd: 'saveAs' },
      { label: 'すべて保存', cmd: 'saveAll' },
      null,
      { label: 'PDFに書き出し…', key: 'Ctrl+P', cmd: 'exportPdf' },
      { label: 'PDFの余白を設定…', cmd: 'pdfMargin' },
      null,
      { label: '閉じる', key: 'Ctrl+W', cmd: 'close' },
    ],
  },
  view: {
    button: $('menu-view'),
    key: 'v',
    items: () => [
      // フォルダビューは「フォルダを開く...」で開いた時だけ表示できる
      {
        label: 'フォルダを表示',
        checked: folderView.isOpen && isPaneVisible('no-folderpane'),
        disabled: !folderView.isOpen,
        cmd: 'toggleFolder',
      },
      { label: 'アウトラインを表示', checked: isPaneVisible('no-outline'), cmd: 'toggleOutline' },
      { label: 'ステータスバーを表示', checked: isPaneVisible('no-statusbar'), cmd: 'toggleStatusbar' },
      null,
      { label: 'ソースモード', checked: state.sourceMode, cmd: 'toggleSource' },
      null,
      // 表示倍率（mde のステータスバーの「－」「100%」「＋」と同じ）
      { label: `表示倍率：${Math.round(zoomLevel * 100)}%`, heading: true },
      { label: '拡大', key: 'Ctrl++', cmd: 'zoomIn', disabled: zoomLevel >= ZOOM_MAX },
      { label: '縮小', key: 'Ctrl+-', cmd: 'zoomOut', disabled: zoomLevel <= ZOOM_MIN },
      { label: '100%に戻す', key: 'Ctrl+0', cmd: 'zoomReset', disabled: 1 === zoomLevel },
      null,
      { label: '段落中の改行', heading: true },
      { label: 'ソースの通りに改行する', checked: !joinSoftBreaks, cmd: 'softBreakSource' },
      { label: '空行が入るまで改行しない', checked: joinSoftBreaks, cmd: 'softBreakJoin' },
    ],
  },
  help: {
    button: $('menu-help'),
    key: 'h',
    items: () => [
      { label: 'Readmeを開く', key: 'F1', cmd: 'readme' },
      null,
      { label: 'バージョン情報', cmd: 'about' },
    ],
  },
};
/** 開いているメニューの名前（MENUS のキー。開いていなければ null）。 */
let openMenuName = null;
/** ボタンを押した時点で、そのボタンのメニューが開いていたか（メニューは、ボタンの mousedown で先に閉じられるため）。 */
let menuWasOpen = false;

/**
 * メニューを、ボタンの真下に開く（右クリックのメニューと同じ見た目・操作。editor.js の showMenu）。
 * 別のメニューが開いていれば、それは閉じる。
 * @param {string} a_name メニューの名前（MENUS のキー）
 * @param {boolean} [a_keyboard] キーボード（Alt+F 等・左右の矢印キー）で開いたか（最初の項目を選んだ状態で開く）
 */
function showBarMenu(a_name, a_keyboard = false) {
  barMenuMode = false;
  const def = MENUS[a_name];
  const rect = def.button.getBoundingClientRect();
  if (host) {
    // ホストの WPF のメニューで開く（ウィンドウの外まで広がって表示できるように。長いパスの「最近使ったファイル」等も
    // 省略せずに表示する。見た目は右クリックのメニューとそろえてある。Program.cs の ShowWebMenu・WebMenu.xaml）。
    // メニューバーのボタンの名前と位置（並んでいる順）も送る（ホスト側で、メニューを開いている間に別のボタンへ
    // マウスを移した時・左右の矢印キーを押した時に切り替えるため。「検索と置換」のようにメニューを持たないボタンも含める）
    hostMenuItems = new Map();
    const buttons = [...document.querySelectorAll('#menubar > button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { name: barButtonName(b), left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    send({ cmd: 'showMenu', name: a_name, x: rect.left, y: rect.bottom + 2, items: menuItemsForHost(def.items()), buttons, keyboard: a_keyboard });
    openMenuName = a_name;
    def.button.classList.add('menu-open');
    return;
  }
  showMenu(rect.left, rect.bottom + 2, def.items(), (a_item) => (a_item.run ? a_item.run() : commands[a_item.cmd]()),
    { keyboard: a_keyboard, onNavigate: (a_dir) => navigateBar(def.button, a_dir) });
  openMenuName = a_name;
  def.button.classList.add('menu-open');
  // メニューが閉じた（項目を選んだ・外をクリックした・Esc）ことを、メニューの要素が無くなったことで知る
  const menu = document.querySelector('.md-menu');
  new MutationObserver((a_records, a_observer) => {
    if (!menu.isConnected) {
      def.button.classList.remove('menu-open');
      // 矢印キーで「検索と置換」を経由して開いた場合等、入力先がどこにも無ければ、編集領域に戻す
      if (document.activeElement === document.body && !document.querySelector('.md-menu')) editor.focus();
      if (openMenuName === a_name && !document.querySelector('.md-menu')) openMenuName = null;
      a_observer.disconnect();
    }
  }).observe(document.body, { childList: true });
}

/** ホストに開いてもらったメニューの項目（番号 → 項目。選ばれた時に menuSelected で番号が届く）。 */
let hostMenuItems = new Map();

/**
 * メニューの項目を、ホストに送る形にする（選べる項目には番号を付けて、hostMenuItems に覚えておく）。
 * @param {(object|null)[]} a_items 項目（editor.js の showMenu と同じ形。null は区切り線）
 * @returns {(object|null)[]}
 */
function menuItemsForHost(a_items) {
  return a_items.map((item) => {
    if (!item) return null;
    if (item.heading) return { label: item.label, heading: true };
    const out = { label: item.label, key: item.key || '', checked: !!item.checked, disabled: !!item.disabled };
    if (item.title && item.title !== item.label) out.title = item.title;
    if (item.submenu) {
      out.submenu = menuItemsForHost(item.submenu);
    } else {
      out.id = hostMenuItems.size + 1;
      hostMenuItems.set(out.id, item);
    }
    return out;
  });
}

/**
 * メニューバーのボタンの名前（メニューのボタンは MENUS のキー、「検索と置換」等は data-cmd）。
 * @param {HTMLElement} a_button メニューバーのボタン
 * @returns {string}
 */
function barButtonName(a_button) {
  return Object.keys(MENUS).find((n) => MENUS[n].button === a_button) || a_button.dataset.cmd;
}

/**
 * メニューバーで、左右の矢印キーで隣のボタンへ移る（Windows のメニューバーと同じ。端まで来たら反対の端へ）。
 * 移った先がメニューならキーボードで開き、「検索と置換」のようにメニューを持たないボタンなら、選んだ状態にする。
 * @param {HTMLElement} a_from 今のボタン
 * @param {number} a_dir 右が 1、左が -1
 */
function navigateBar(a_from, a_dir) {
  const all = [...document.querySelectorAll('#menubar > button')];
  const next = all[(all.indexOf(a_from) + a_dir + all.length) % all.length];
  const name = barButtonName(next);
  if (MENUS[name]) {
    showBarMenu(name, true);
  } else {
    next.classList.add('menu-open');
    next.focus();
  }
}
// メニューを持たないボタン（「検索と置換」）を矢印キーで選んでいる間：Enter・スペースで実行、左右の矢印キーで隣へ、
// Esc でやめて編集に戻る
document.querySelectorAll('#menubar > button[data-cmd]').forEach((button) => {
  button.addEventListener('blur', () => button.classList.remove('menu-open'));
  button.addEventListener('keydown', (e) => {
    if (!button.classList.contains('menu-open')) return;
    if ('ArrowLeft' === e.key || 'ArrowRight' === e.key) {
      e.preventDefault();
      e.stopPropagation();
      button.blur();
      navigateBar(button, 'ArrowRight' === e.key ? 1 : -1);
    } else if ('Escape' === e.key) {
      e.preventDefault();
      button.blur();
      editor.focus();
    } else if ('Enter' === e.key || ' ' === e.key) {
      e.preventDefault();
      button.blur();
      commands[button.dataset.cmd]();
    }
  });
});
for (const [name, def] of Object.entries(MENUS)) {
  // ボタンを押した時点で開いていたかを、メニューが閉じられる前（window の capture は document より先）に記録する
  window.addEventListener('mousedown', (e) => {
    if (def.button.contains(e.target)) menuWasOpen = openMenuName === name;
  }, true);
  // mousedown で既定の動作を止めて、編集中のカーソル位置を保つ（メニューを閉じた後、そのまま書き続けられるように）
  def.button.addEventListener('mousedown', (e) => e.preventDefault());
  def.button.addEventListener('click', () => {
    if (menuWasOpen) {
      menuWasOpen = false; // 開いていたメニューは mousedown で閉じたので、開き直さない
      return;
    }
    showBarMenu(name);
  });
  // 別のメニューが開いている時は、ボタンにマウスを乗せただけで、そのメニューに切り替える（Windows のメニューと同じ）
  def.button.addEventListener('mouseenter', () => {
    if ((openMenuName && openMenuName !== name) || barMenuMode) showBarMenu(name);
  });
}
/** メニューを開いている間に、マウスをメニューを持たないボタン（「検索と置換」）へ移したか（その間にマウスを
 * メニューのボタンへ戻したら、そのメニューを開く。Windows のメニューバーと同じ）。 */
let barMenuMode = false;
// メニューを開いている間に「検索と置換」へマウスを移したら、開いているメニューを閉じる
document.querySelectorAll('#menubar > button[data-cmd]').forEach((button) => {
  button.addEventListener('mouseenter', () => {
    if (!openMenuName) return;
    closeMenu();
    barMenuMode = true;
  });
});
// メニューバーの外へマウスを移したら、メニューを開いていない状態に戻る
$('menubar').addEventListener('mouseleave', () => { barMenuMode = false; });

// ショートカット：Ctrl+S 保存、Ctrl+Shift+S 名前を付けて保存、Ctrl+O 開く、Ctrl+N 新規、Ctrl+F 検索と置換、
// Ctrl+P PDFに書き出し、Ctrl+W 閉じる、F1 Readmeを開く、F12 開発者ツール、
// Alt+F「ファイル」・Alt+V「表示」・Alt+H「ヘルプ」のメニュー
window.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const name = Object.keys(MENUS).find((n) => MENUS[n].key === e.key.toLowerCase());
    if (name) {
      e.preventDefault();
      if (openMenuName !== name) showBarMenu(name, true);
      return;
    }
  }
  // F1：Readme を開く（mde と同じ。検索と置換等のダイアログでの F1 は、ホスト側の Program.Main で受ける）
  if ('F1' === e.key && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); commands.readme(); return; }
  // F12：開発者ツール（画面側の調査・デバッグ用）。ブラウザ用のショートカットは無効にしてあるため、ホストに開いてもらう
  if ('F12' === e.key && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); send({ cmd: 'devTools' }); return; }
  // 検証用：Ctrl+Shift+F12 で IME をオンにする（ホスト側の ForceImeOn 参照）
  if (e.ctrlKey && e.shiftKey && 'F12' === e.key) { e.preventDefault(); send({ cmd: 'imeOn' }); return; }
  if (!e.ctrlKey || e.altKey) return;
  // 表示倍率：Ctrl++（日本語キーボードの Ctrl+; も）・Ctrl+-・Ctrl+0（テンキーも）
  if ('+' === e.key || '=' === e.key || ';' === e.key) { e.preventDefault(); commands.zoomIn(); return; }
  if ('-' === e.key) { e.preventDefault(); commands.zoomOut(); return; }
  if ('0' === e.key && !e.shiftKey) { e.preventDefault(); commands.zoomReset(); return; }
  const k = e.key.toLowerCase();
  if ('s' === k) { e.preventDefault(); doSave(e.shiftKey); }
  else if ('o' === k) { e.preventDefault(); doOpen(); }
  else if ('n' === k) { e.preventDefault(); doNew(); }
  else if ('f' === k && !e.shiftKey) { e.preventDefault(); openFindWindow(); }
  else if ('p' === k && !e.shiftKey) { e.preventDefault(); doExportPdf(); }
  else if ('w' === k && !e.shiftKey) { e.preventDefault(); commands.close(); }
});

/**
 * ファイルを開くのを待っている要求があれば、結果を渡す。
 * @param {string|null} a_path 開いたファイルのパス
 * @param {boolean} a_ok 開けたか
 */
function resolveOpenWaiter(a_path, a_ok) {
  if (openWaiter && a_path && pathKey(a_path) === openWaiter.key) {
    openWaiter.resolve(a_ok);
    openWaiter = null;
  }
}

/**
 * 保存したファイルをフォルダビューで選択する。名前を付けて保存でフォルダの中に新しいファイルができた場合は、
 * そのフォルダの一覧を読み込み直す。
 * @param {string} a_path 保存したファイルのパス
 */
async function revealSavedFile(a_path) {
  if (folderView.isOpen && folderView.contains(a_path) && !folderView.has(a_path)) {
    await folderView.reload(a_path.replace(/[\\/][^\\/]*$/, ''));
  }
  folderView.setCurrent(a_path);
}

// ---- ホストからのメッセージ --------------------------------------------------
if (host) {
  host.addEventListener('message', (ev) => {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if ('load' === msg.cmd) {
      // ファイルを開いた（起動時の引数・開くダイアログ・相対パスのリンク・フォルダビュー・検索結果）
      const samePath = !!state.path && !!msg.path && pathKey(state.path) === pathKey(msg.path);
      if (samePath && state.dirty && !confirm('保存されていない変更を破棄して、ファイルを読み直しますか？')) {
        resolveOpenWaiter(msg.path, true);
        return;
      }
      // フォルダを開いている時は、今のファイルの保存していない変更を置いておく（そのファイルを開き直すと戻る）
      if (!samePath && state.path && state.dirty && folderView.isOpen) {
        const text = currentMarkdown();
        pendingEdits.set(pathKey(state.path), {
          path: state.path, markdown: text, images: state.sourceMode ? imageSourcesIn(text) : editor.collectImageSources(),
        });
      }
      setDocumentBase(msg.docBase);
      state.path = msg.path;
      state.name = msg.name;
      const pending = msg.path ? pendingEdits.get(pathKey(msg.path)) : null;
      if (pending) {
        // 保存せずに置いてあった内容を表示する（未保存のまま。mde は未保存の印が消えるが、消さない）
        pendingEdits.delete(pathKey(msg.path));
        loadDocument(pending.markdown);
        setDirty(true);
      } else {
        loadDocument(msg.markdown);
      }
      updateTitle();
      syncDirtyToHost();
      folderView.setCurrent(msg.path);
      findEngine.onDocumentLoaded();
      resolveOpenWaiter(msg.path, true);
    } else if ('folderOpened' === msg.cmd) {
      // フォルダを開いた（保存していない変更は、確認の上で破棄する。この後、開くファイルの load が届く）
      pendingEdits.clear();
      setDirty(false);
      syncDirtyToHost();
      document.body.classList.add('folder-open');
      document.body.classList.remove('no-folderpane');
      $('folder-title').title = msg.root;
      folderView.open(msg.root, msg.name);
    } else if ('findCommand' === msg.cmd) {
      // 検索と置換のウィンドウのボタンが押された（find.js の handle）
      findEngine.handle(msg);
    } else if ('dirList' === msg.cmd) {
      const waiters = dirListWaiters.get(pathKey(msg.path)) || [];
      dirListWaiters.delete(pathKey(msg.path));
      for (const resolve of waiters) resolve({ dirs: msg.dirs || [], files: msg.files || [] });
    } else if ('folderFiles' === msg.cmd) {
      const resolve = folderFilesWaiters.get(msg.reqId);
      folderFilesWaiters.delete(msg.reqId);
      if (resolve) resolve(msg.files || []);
    } else if ('savedAll' === msg.cmd) {
      // すべて保存が終わった（開いているファイルの分は、先に saved が届いている）
      for (const p of msg.saved || []) pendingEdits.delete(pathKey(p));
      folderView.refresh();
      syncDirtyToHost();
      let text = `${(msg.saved || []).length} 個のファイルを保存しました。`;
      if (msg.failed && msg.failed.length) {
        text += `\n\n保存に失敗したファイル:\n${msg.failed.map((f) => `${f.path} (${f.message})`).join('\n')}`;
      }
      alert(text);
    } else if ('saved' === msg.cmd) {
      // 保存が終わった（名前を付けて保存の場合は、新しいパス・画像の基準の場所になる）
      if (msg.docBase) setDocumentBase(msg.docBase);
      state.path = msg.path;
      state.name = msg.name;
      if (state.sourceMode) {
        // ソースモード：保存した内容（貼り付けた画像の参照先を書き換えた後のもの）で、入力欄と編集部分をそろえる
        if (sourceArea.value !== msg.markdown) {
          const caret = Math.min(sourceArea.selectionStart, msg.markdown.length);
          sourceArea.value = msg.markdown;
          sourceArea.setSelectionRange(caret, caret);
        }
        editor.load(msg.markdown);
        sourceOriginal = msg.markdown;
        sourceNeedsReload = false;
        sourceBackdropStale = true;
        state.pendingSave = null;
        pendingEdits.delete(pathKey(msg.path));
        setDirty(false);
        updateTitle();
        revealSavedFile(msg.path);
        return;
      }
      let result = state.pendingSave;
      if (msg.replacements && Object.keys(msg.replacements).length) {
        // 貼り付けた画像を保存先へ移した等で画像の参照先が変わった場合は、画面の画像も書き換えて、
        // 書き換え後の内容を元テキストとして取り込み直す
        editor.applyImageSrcReplacements(msg.replacements);
        result = editor.serialize();
      }
      if (result) editor.markSaved(result);
      state.pendingSave = null;
      pendingEdits.delete(pathKey(msg.path));
      setDirty(false);
      updateTitle();
      revealSavedFile(msg.path);
    } else if ('imagePasted' === msg.cmd) {
      // 貼り付けた画像を、ホストが一時フォルダに保存し終えた
      editor.insertImage(msg.url, msg.alt);
    } else if ('error' === msg.cmd) {
      alert(msg.message);
      if (openWaiter) {
        openWaiter.resolve(false);
        openWaiter = null;
      }
    } else if ('focus' === msg.cmd) {
      // 起動直後：ウィンドウが表示されたら、すぐに書き始められるよう編集領域にカーソルを置く
      editor.focus();
    } else if ('init' === msg.cmd) {
      // 起動直後：ホストの設定。Debug ビルドの時は、停止・入力遅延の回数を数えて表示する
      state.tempDir = msg.tempDir || null;
      if (msg.debug) startStallMonitor();
    } else if ('imagesImported' === msg.cmd) {
      // 他のアプリの画像を、一時フォルダへコピーし終えた（importImages）
      const resolve = importWaiters.get(msg.id);
      importWaiters.delete(msg.id);
      if (resolve) resolve(msg.urls || []);
    } else if ('recentFiles' === msg.cmd) {
      // 最近使ったファイル・フォルダの一覧（開いた・保存した時、ウィンドウが手前に来た時に届く）
      state.recentFiles = msg.files || [];
      state.recentFolders = msg.folders || [];
    } else if ('menuSelected' === msg.cmd) {
      // メニューバーのメニュー（ホストの WPF のメニュー）で項目が選ばれた
      const item = hostMenuItems.get(msg.id);
      if (item) {
        if (item.run) item.run();
        else commands[item.cmd]();
      }
    } else if ('menuClosed' === msg.cmd) {
      // メニューバーのメニューが閉じた（項目を選んだ・外をクリックした・Esc）
      MENUS[msg.name]?.button.classList.remove('menu-open');
      if (openMenuName === msg.name) openMenuName = null;
    } else if ('menuSwitch' === msg.cmd) {
      // メニューを開いている間に、別のボタンへマウスを移した・左右の矢印キーを押した
      const button = [...document.querySelectorAll('#menubar > button')].find((b) => barButtonName(b) === msg.name);
      if (MENUS[msg.name]) {
        showBarMenu(msg.name, !!msg.keyboard);
      } else if (button && msg.keyboard) {
        // 矢印キーで「検索と置換」へ移った：そのボタンを選んだ状態にする（Enter で実行）
        button.classList.add('menu-open');
        button.focus();
      } else {
        // マウスを「検索と置換」へ移した：メニューは閉じたまま、メニューのボタンへマウスを戻したら開く
        barMenuMode = true;
      }
    } else if ('tableSize' === msg.cmd) {
      // 右クリックの「表を挿入…」のダイアログを閉じた（行数・列数が 0 なら取りやめ）
      const anchor = tableAnchor;
      tableAnchor = null;
      if (msg.rows > 0 && msg.cols > 0 && !state.sourceMode) editor.insertTable(anchor, msg.rows, msg.cols);
    } else if ('linkUrl' === msg.cmd) {
      // 右クリックの「リンクにする…」のダイアログを閉じた（url が空なら取りやめ）
      const range = linkRange;
      linkRange = null;
      if (msg.url && !state.sourceMode) editor.makeLink(range, msg.url);
    } else if ('pdfExported' === msg.cmd) {
      // PDF に書き出し終わった（キャンセルした場合も）。印刷用の要素を空にする
      exportingPdf = false;
      $('print-doc').replaceChildren();
    }
  });
} else {
  $('status-host').textContent = 'ブラウザ単体（保存・開くは無効）';
}

// ---- 停止・入力遅延の検出（IMEフリーズ検証用。Debug ビルドの時だけ）------------
/**
 * 停止・入力遅延の回数を数えて、ステータスバーに表示する（Debug ビルドの時だけ。ホストからの init で呼ぶ。
 * ブラウザ単体で開いた場合は、動作確認用として常に呼ぶ）。
 *  - 停止：画面のメインスレッドが200ms以上止まると、20ms ごとの間隔タイマーが遅れて動くことで検出する
 *  - 入力遅延：event.timeStamp（OSが入力を受け取った時刻）から、画面側で受け取るまでに200ms以上かかった回数
 * 起動直後の読み込みの停止は検証の対象外なので、2秒後に回数を数え直す。
 */
function startStallMonitor() {
  if (document.body.classList.contains('debug')) return; // 2回目以降は何もしない
  document.body.classList.add('debug');
  let stalls = 0;
  let maxStall = 0;
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick;
    if (gap > 200) {
      stalls++;
      maxStall = Math.max(maxStall, gap);
      $('status-stall').textContent = `停止 ${stalls}回（最長 ${Math.round(maxStall)}ms）`;
    }
    lastTick = now;
  }, 20);
  let lags = 0;
  let maxLag = 0;
  for (const type of ['keydown', 'pointerdown', 'compositionupdate', 'compositionend', 'beforeinput']) {
    window.addEventListener(type, (e) => {
      const lag = performance.now() - e.timeStamp;
      if (lag > 200 && lag < 60000) {
        lags++;
        maxLag = Math.max(maxLag, lag);
        $('status-lag').textContent = `入力遅延 ${lags}回（最長 ${Math.round(maxLag)}ms）`;
      }
    }, true);
  }
  setTimeout(() => {
    stalls = 0; maxStall = 0; lags = 0; maxLag = 0;
    $('status-stall').textContent = '停止 0回';
    $('status-lag').textContent = '入力遅延 0回';
  }, 2000);
}

// ---- 自動テスト用の窓口 -------------------------------------------------------
// ブラウザ単体で開いて自動テストする時に使う（load：文書を読み込む、get：保存する内容を得る）。
window.__mdeTest = {
  load: (a_md) => loadDocument(a_md),
  get: () => currentMarkdown(),
  find: (a_msg) => findEngine.handle(a_msg),
  findUpdates,
  editor,
};

// ---- 起動 -----------------------------------------------------------------
// 空の文書を表示してから、ホストに準備ができたことを知らせる（ホストから init が届き、
// 起動時の引数のファイルがあれば load が届く）。ブラウザ単体の場合は、停止・入力遅延の回数も表示する。
loadDocument('');
updateTitle();
send({ cmd: 'ready' });
if (!host) startStallMonitor();
