// mdew：画面全体の動きと、C# 側ホスト（WebView2）とのやり取り。
//
// ホストとのメッセージ（JSON）:
//   web → host : {cmd:'ready'} / {cmd:'open'} / {cmd:'save', markdown, saveAs, images} /
//                {cmd:'dirty', value} / {cmd:'newWindow'} / {cmd:'pasteImage', id, type, data} / {cmd:'imeOn'} /
//                {cmd:'openUrl', url} / {cmd:'openRelative', path} / {cmd:'devTools'} / {cmd:'about'}
//   host → web : {cmd:'load', path, name, docBase, markdown} /
//                {cmd:'saved', path, name, docBase, markdown, replacements} /
//                {cmd:'imagePasted', id, url, alt} / {cmd:'error', message} / {cmd:'focus'} / {cmd:'init', debug}
import { Editor, showMenu } from './editor.js';
import { setJoinSoftBreaks } from './markdown.js';

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
};

/**
 * ホストにメッセージを送る（ブラウザ単体の場合は何もしない）。
 * @param {object} a_msg メッセージ（cmd と、cmd ごとの値。冒頭のコメント参照）
 */
function send(a_msg) {
  if (host) host.postMessage(JSON.stringify(a_msg));
}

/** 編集部分（editor.js）。変更・画像の貼り付け・リンクの操作は、ここで受け取ってホストとやり取りする。 */
const editor = new Editor($('doc'), {
  onChange: () => {
    setDirty(true);
    scheduleOutline();
  },
  onOpenLink: (a_href) => openLink(a_href),
  onError: (a_message) => alert(a_message),
  onHoverLink: (a_href) => {
    $('status-link').textContent = a_href ? `クリックで開く：${a_href}` : '';
  },
  onPasteImage: (a_file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).replace(/^data:[^,]*,/, '');
      send({ cmd: 'pasteImage', id: state.nextImageId++, type: a_file.type, data });
    };
    reader.readAsDataURL(a_file);
  },
});

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
  send({ cmd: 'dirty', value: a_value });
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
/** アウトラインを作り直す（見出しをクリックすると、その見出しへ移動する）。 */
function buildOutline() {
  const list = $('outline-list');
  list.replaceChildren();
  for (const h of editor.headings()) {
    const li = document.createElement('li');
    li.textContent = h.textContent.replace(/\u200b/g, '').trim() || '(無題)';
    li.title = li.textContent; // 幅が足りずに見切れた時も、マウスを乗せれば全体が見えるように
    li.className = `lv${h.tagName.substring(1)}`;
    li.addEventListener('click', () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    list.appendChild(li);
  }
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
    if (state.dirty && !confirm('保存されていない変更があります。破棄してリンク先のファイルを開きますか？')) return;
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
 * 見出しの文字から、リンク先の名前（#以降）を作る。GitHub・Typora 等と同じ規則：
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
  const target = decodeURIComponentSafe(a_fragment).toLowerCase();
  const used = new Map();
  for (const h of editor.headings()) {
    const base = slugify(h.textContent.replace(/\u200b/g, ''));
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    const slug = 0 === count ? base : `${base}-${count}`;
    if (slug === target || h.textContent.trim().toLowerCase() === target) {
      h.scrollIntoView({ block: 'start', behavior: 'smooth' });
      const range = document.createRange();
      range.setStart(h, 0);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
  }
  alert(`リンク先の見出しが見つかりません。\n#${a_fragment}`);
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
// 境界をドラッグしている間、アウトラインの幅を変える（離した時に保存する）
$('splitter').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const splitter = e.currentTarget;
  splitter.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = $('outline').getBoundingClientRect().width;
  let width = startWidth;
  document.body.classList.add('resizing');
  const onMove = (ev) => { width = setOutlineWidth(startWidth + ev.clientX - startX); };
  const onUp = () => {
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onUp);
    splitter.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('resizing');
    saveOutlineWidth(width);
  };
  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onUp);
  splitter.addEventListener('pointercancel', onUp);
});
// 境界をダブルクリックすると既定の幅に戻す
$('splitter').addEventListener('dblclick', () => saveOutlineWidth(setOutlineWidth(OUTLINE_DEFAULT_WIDTH)));

// ---- コマンド ---------------------------------------------------------------
/**
 * 文書を表示し、未保存の印を消して、アウトラインを作り直す。
 * @param {string} a_markdown 文書の全体（新規は ''）
 */
function loadDocument(a_markdown) {
  editor.load(a_markdown);
  setDirty(false);
  buildOutline();
  editor.focus();
}
/** 新規：新しいウィンドウを開く（今のウィンドウの内容はそのまま）。 */
function doNew() {
  send({ cmd: 'newWindow' });
}
/** 開く：未保存の変更があれば確認してから、ホストにファイルを開くダイアログを出してもらう。 */
function doOpen() {
  if (state.dirty && !confirm('保存されていない変更があります。破棄して別のファイルを開きますか？')) return;
  send({ cmd: 'open' });
}
/**
 * 保存：内容を Markdown にしてホストに渡す。新規の文書は「名前を付けて保存」になる。
 * 保存が終わると、ホストから saved が届く。
 * @param {boolean} a_saveAs 名前を付けて保存か
 */
function doSave(a_saveAs) {
  const result = editor.serialize();
  state.pendingSave = result;
  send({ cmd: 'save', markdown: result.text, saveAs: !!a_saveAs || !state.path, images: editor.collectImageSources() });
}

/** メニューのボタン（data-cmd 属性）とコマンドの対応。 */
const commands = {
  new: doNew,
  open: doOpen,
  save: () => doSave(false),
  saveAs: () => doSave(true),
  toggleOutline: () => togglePane('no-outline'),
  toggleStatusbar: () => togglePane('no-statusbar'),
  softBreakSource: () => setSoftBreakMode(false),
  softBreakJoin: () => setSoftBreakMode(true),
  about: () => send({ cmd: 'about' }), // バージョン情報のウィンドウ（ホスト側の dialog\AboutWindow）
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
      null,
      { label: '保存', key: 'Ctrl+S', cmd: 'save' },
      { label: '名前を付けて保存', key: 'Ctrl+Shift+S', cmd: 'saveAs' },
    ],
  },
  view: {
    button: $('menu-view'),
    key: 'v',
    items: () => [
      { label: 'アウトラインを表示', checked: isPaneVisible('no-outline'), cmd: 'toggleOutline' },
      { label: 'ステータスバーを表示', checked: isPaneVisible('no-statusbar'), cmd: 'toggleStatusbar' },
      null,
      { label: '段落中の改行', heading: true },
      { label: 'ソースの通りに改行する', checked: !joinSoftBreaks, cmd: 'softBreakSource' },
      { label: '空行が入るまで改行しない', checked: joinSoftBreaks, cmd: 'softBreakJoin' },
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
 */
function showBarMenu(a_name) {
  const def = MENUS[a_name];
  const rect = def.button.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 2, def.items(), (a_item) => commands[a_item.cmd]());
  openMenuName = a_name;
  // メニューが閉じた（項目を選んだ・外をクリックした・Esc）ことを、メニューの要素が無くなったことで知る
  const menu = document.querySelector('.md-menu');
  new MutationObserver((a_records, a_observer) => {
    if (!menu.isConnected) {
      if (openMenuName === a_name && !document.querySelector('.md-menu')) openMenuName = null;
      a_observer.disconnect();
    }
  }).observe(document.body, { childList: true });
}
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
    if (openMenuName && openMenuName !== name) showBarMenu(name);
  });
}

// ショートカット：Ctrl+S 保存、Ctrl+Shift+S 名前を付けて保存、Ctrl+O 開く、Ctrl+N 新規、F12 開発者ツール、
// Alt+F「ファイル」・Alt+V「表示」のメニュー
window.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const name = Object.keys(MENUS).find((n) => MENUS[n].key === e.key.toLowerCase());
    if (name) {
      e.preventDefault();
      if (openMenuName !== name) showBarMenu(name);
      return;
    }
  }
  // F12：開発者ツール（画面側の調査・デバッグ用）。ブラウザ用のショートカットは無効にしてあるため、ホストに開いてもらう
  if ('F12' === e.key && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); send({ cmd: 'devTools' }); return; }
  // 検証用：Ctrl+Shift+F12 で IME をオンにする（ホスト側の ForceImeOn 参照）
  if (e.ctrlKey && e.shiftKey && 'F12' === e.key) { e.preventDefault(); send({ cmd: 'imeOn' }); return; }
  if (!e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ('s' === k) { e.preventDefault(); doSave(e.shiftKey); }
  else if ('o' === k) { e.preventDefault(); doOpen(); }
  else if ('n' === k) { e.preventDefault(); doNew(); }
});

// ---- ホストからのメッセージ --------------------------------------------------
if (host) {
  host.addEventListener('message', (ev) => {
    const msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if ('load' === msg.cmd) {
      // ファイルを開いた（起動時の引数・開くダイアログ・相対パスのリンク）
      setDocumentBase(msg.docBase);
      state.path = msg.path;
      state.name = msg.name;
      loadDocument(msg.markdown);
      updateTitle();
    } else if ('saved' === msg.cmd) {
      // 保存が終わった（名前を付けて保存の場合は、新しいパス・画像の基準の場所になる）
      if (msg.docBase) setDocumentBase(msg.docBase);
      state.path = msg.path;
      state.name = msg.name;
      let result = state.pendingSave;
      if (msg.replacements && Object.keys(msg.replacements).length) {
        // 貼り付けた画像を保存先へ移した等で画像の参照先が変わった場合は、画面の画像も書き換えて、
        // 書き換え後の内容を元テキストとして取り込み直す
        editor.applyImageSrcReplacements(msg.replacements);
        result = editor.serialize();
      }
      if (result) editor.markSaved(result);
      state.pendingSave = null;
      setDirty(false);
      updateTitle();
    } else if ('imagePasted' === msg.cmd) {
      // 貼り付けた画像を、ホストが一時フォルダに保存し終えた
      editor.insertImage(msg.url, msg.alt);
    } else if ('error' === msg.cmd) {
      alert(msg.message);
    } else if ('focus' === msg.cmd) {
      // 起動直後：ウィンドウが表示されたら、すぐに書き始められるよう編集領域にカーソルを置く
      editor.focus();
    } else if ('init' === msg.cmd) {
      // 起動直後：ホストの設定。Debug ビルドの時は、停止・入力遅延の回数を数えて表示する
      if (msg.debug) startStallMonitor();
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
  get: () => editor.serialize().text,
  editor,
};

// ---- 起動 -----------------------------------------------------------------
// 空の文書を表示してから、ホストに準備ができたことを知らせる（ホストから init が届き、
// 起動時の引数のファイルがあれば load が届く）。ブラウザ単体の場合は、停止・入力遅延の回数も表示する。
loadDocument('');
updateTitle();
send({ cmd: 'ready' });
if (!host) startStallMonitor();
