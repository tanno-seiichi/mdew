// mdew：Excel・Word 等の他のアプリとのコピー・貼り付け（mde の ClipboardHtmlBuilder・TableEditor の移植）。
//
//  - 通常のコピー（Ctrl+C・Ctrl+X）：文字（text/plain）に加えて、見た目を保った HTML（text/html。表には罫線、
//    画像はファイルの場所）と、mdew 用の Markdown（text/x-mdew-markdown）を書き込む。mdew どうしの貼り付けは
//    Markdown を使うので、見出し・リスト・表等の書式がそのまま貼り付く。
//  - 右クリックの「Excel用にコピー」：選んだ見出し・段落・項目等を、Excel で1行1セルに分かれて、見た目も
//    保って貼り付くよう、1列の表の HTML にしてコピーする（mde と同じ）。表の中では、選んだセルの範囲をコピーする。
//  - 右クリックの「表をコピー」：表全体を、罫線付きの HTML とタブ区切りの文字でコピーする（mde と同じ）。
//  - 貼り付け：Excel 等からコピーした表（HTML の表・タブ区切りの文字）は、Markdown の表として貼り付ける
//    （mde と同じ。1つ目の行を見出しの行にする）。
//
// クリップボードへの書き込みは、copy イベントで行う（writeClipboard。document.execCommand('copy') で起こす）。
import { serializeBlock, serializeInline, escapeText, imageSource } from './markdown.js';

/** mdew 用の Markdown をクリップボードに入れる時の形式の名前。 */
export const MARKDOWN_MIME = 'text/x-mdew-markdown';
/** Excel の既定の行の高さ（ピクセル。15pt）。画像の後ろに入れる空の行の数の計算に使う（mde と同じ）。 */
const EXCEL_DEFAULT_ROW_HEIGHT_PX = 20;
/** Excel に貼り付ける表のセルの罫線（mde と同じ）。 */
const CELL_STYLE = 'border:0.5pt solid windowtext;padding:4px 8px;';
/** Excel に貼り付ける表の外側（mde と同じ）。 */
const TABLE_OPEN = '<table border="0" cellspacing="0" cellpadding="4" style="border-collapse:collapse;">';
/** 見出しの文字の大きさ（pt。mde と同じ）。 */
const HEADING_PT = [22, 18, 15.5, 14, 13, 12];

/** クリップボードへの書き込みをホストに頼む関数（setHostClipboardWriter。ブラウザ単体では null）。 */
let s_hostWriter = null;

/**
 * 「Excel用にコピー」「表をコピー」の書き込みを、ホストに頼むようにする。ブラウザ（WebView2）が書き込む HTML には、
 * 元のページの場所（https://app.mdew/…）が付くため、Excel がインターネット上のページとして扱って、PC の中の画像
 * （file:///…）を読み込まないことがある。ホストが mde と同じ形（元の場所なし・画像は一時フォルダへコピー）で書き込む。
 * @param {((data: {text:string, html:string}) => void)|null} a_writer 書き込む関数
 */
export function setHostClipboardWriter(a_writer) {
  s_hostWriter = a_writer;
}

/** writeClipboard で書き込む内容（次の copy イベントで使う）。 */
let s_pending = null;
/** このウィンドウで最後にコピーした内容（右クリックの「貼り付け」は独自の形式を読めないため、文字が同じなら使う）。 */
let s_lastCopy = null;

// writeClipboard からの copy イベントは、編集領域の copy の処理より先に受け取る
document.addEventListener('copy', (e) => {
  if (!s_pending) return;
  const data = s_pending;
  s_pending = null;
  e.preventDefault();
  e.stopImmediatePropagation();
  setClipboardData(e.clipboardData, data);
}, true);

/**
 * copy イベントの clipboardData に内容を書き込む。
 * @param {DataTransfer} a_dt clipboardData
 * @param {{text:string, html?:string, markdown?:string}} a_data 書き込む内容
 */
export function setClipboardData(a_dt, a_data) {
  a_dt.setData('text/plain', a_data.text);
  if (a_data.html) a_dt.setData('text/html', a_data.html);
  if (null != a_data.markdown) a_dt.setData(MARKDOWN_MIME, a_data.markdown);
  s_lastCopy = null != a_data.markdown ? { text: normalizeNewlines(a_data.text), markdown: a_data.markdown } : null;
}

/**
 * クリップボードに書き込む（document.execCommand('copy') で copy イベントを起こし、その中で書き込む）。
 * @param {{text:string, html?:string, markdown?:string}} a_data 書き込む内容
 * @returns {boolean} 書き込めたか
 */
export function writeClipboard(a_data) {
  if (s_hostWriter && a_data.html) {
    // ホストが書き込む（Excel 等が画像を読めるよう、mde と同じ形の CF_HTML にする。Program.cs の CopyHtml）
    s_hostWriter(a_data);
    s_lastCopy = null != a_data.markdown ? { text: normalizeNewlines(a_data.text), markdown: a_data.markdown } : null;
    return true;
  }
  s_pending = a_data;
  document.execCommand('copy');
  const ok = null === s_pending;
  s_pending = null;
  return ok;
}

/**
 * このウィンドウで最後にコピーした Markdown（クリップボードの文字が、その時の文字と同じ場合だけ）。
 * @param {string} a_text クリップボードの文字
 * @returns {string|null}
 */
export function lastCopiedMarkdown(a_text) {
  return s_lastCopy && s_lastCopy.text === normalizeNewlines(a_text) ? s_lastCopy.markdown : null;
}

/**
 * 改行を LF にそろえる。
 * @param {string} a_text 文字列
 * @returns {string}
 */
const normalizeNewlines = (a_text) => (a_text || '').replace(/\r\n?/g, '\n');

/**
 * HTML の特殊文字をエスケープする。
 * @param {string} a_text 文字列
 * @returns {string}
 */
function esc(a_text) {
  return a_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 画面の文字から、編集用の文字（ゼロ幅の空白）を取り除く。 */
const clean = (a_text) => a_text.replace(/​/g, '');

// ===== 通常のコピー（Ctrl+C・Ctrl+X） =====

/** 文字を書く単位の要素（この中だけを選んだ場合は、段落の中の一部として扱う）。 */
const TEXT_BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th';
/** ブロック要素（選んだ範囲にこれらが含まれていれば、ブロックの並びとして扱う）。 */
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE',
  'THEAD', 'TBODY', 'TR', 'HR', 'DIV']);

/**
 * 選んだ範囲を、ブロックの並び（コピー用の要素）にする。範囲の外側の要素（リスト・表等）も、書式が分かるよう
 * 中身の無い形で補う（例：リストの項目だけを選んだら ul で囲む）。
 * @param {Range} a_range 選んだ範囲
 * @param {HTMLElement} a_root 編集領域
 * @returns {{inline:boolean, container:HTMLElement}|null} inline は段落の中の一部だけか。
 *   コードブロック等の中だけを選んだ場合は null（文字だけをコピーする）
 */
function selectionContainer(a_range, a_root) {
  const anc = 1 === a_range.commonAncestorContainer.nodeType
    ? a_range.commonAncestorContainer : a_range.commonAncestorContainer.parentElement;
  if (!a_root.contains(anc)) return null;
  if (anc.closest('pre,.md-raw') && a_root.contains(anc.closest('pre,.md-raw'))) return null;
  const fragment = a_range.cloneContents();
  const hasBlock = [...fragment.childNodes].some((n) => 1 === n.nodeType && BLOCK_TAGS.has(n.tagName));
  const textBlock = anc.closest(TEXT_BLOCK_SELECTOR);
  const container = document.createElement('div');
  if (!hasBlock && textBlock && a_root.contains(textBlock)) {
    container.append(fragment);
    return { inline: true, container };
  }
  // 範囲を囲む要素（リスト・表・引用）を、中身の無い形で補う
  let wrapped = fragment;
  let el = anc;
  if ('LI' === el.tagName && hasBlock) {
    const li = el.cloneNode(false);
    li.append(wrapped);
    wrapped = li;
    el = el.parentElement;
  }
  while (el && el !== a_root) {
    if (/^(UL|OL|TABLE|THEAD|TBODY|TR|BLOCKQUOTE)$/.test(el.tagName)) {
      const clone = el.cloneNode(false);
      clone.append(wrapped);
      wrapped = clone;
      if ('BLOCKQUOTE' !== el.tagName && 'TABLE' === el.tagName) break;
    } else if (/^(LI|TD|TH)$/.test(el.tagName)) {
      // 項目・セルの中のリスト等を選んだ場合：中身だけにする（外側の項目・表は補わない）
      break;
    }
    el = el.parentElement;
  }
  container.append(wrapped);
  return { inline: false, container };
}

/**
 * 通常のコピー（Ctrl+C・Ctrl+X・右クリックの「コピー」）の内容を作る。
 * @param {Selection} a_sel 選んだ範囲
 * @param {HTMLElement} a_root 編集領域
 * @param {{bullet:string}} a_opts Markdown の書き出しの設定（serializeBlock）
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所（file:///…・http…）を返す関数
 * @returns {{text:string, html?:string, markdown?:string}}
 */
export function buildCopyData(a_sel, a_root, a_opts, a_imageUrl) {
  const text = clean(a_sel.toString()).replace(/ /g, ' ');
  if (!a_sel.rangeCount) return { text };
  const range = a_sel.getRangeAt(0);
  const sel = selectionContainer(range, a_root);
  if (!sel) return { text };
  const { inline, container } = sel;
  let markdown;
  if (inline) {
    markdown = serializeInline(container).replace(/\n+$/, '');
  } else {
    markdown = [...container.children].map((c) => serializeBlock(c, a_opts)).filter((t) => '' !== t).join('\n\n');
  }
  // HTML：他のアプリで見やすいよう、表に罫線を付け、画像はファイルの場所にする
  for (const img of container.querySelectorAll('img')) {
    const url = a_imageUrl(img);
    if (url) {
      img.setAttribute('src', url);
    } else {
      img.replaceWith(`[画像${img.alt ? `: ${img.alt}` : ''}]`);
    }
  }
  for (const node of container.querySelectorAll('*')) {
    for (const a of [...node.attributes]) if (a.name.startsWith('data-') || 'contenteditable' === a.name) node.removeAttribute(a.name);
  }
  for (const table of container.querySelectorAll('table')) table.setAttribute('style', 'border-collapse:collapse;');
  for (const cell of container.querySelectorAll('td,th')) cell.setAttribute('style', `${CELL_STYLE}${cell.style.cssText || ''}`);
  const html = clean(container.innerHTML);
  return { text, html, markdown };
}

// ===== 「Excel用にコピー」（mde の ClipboardHtmlBuilder・TableEditor.TryCopySelectionForExcel） =====

/**
 * 要素（の一部）が、選んだ範囲と重なるか（範囲の端が要素の端に接しているだけの場合は重ならないとする）。
 * @param {Range} a_range 選んだ範囲
 * @param {Range} a_part 要素の範囲
 * @returns {boolean}
 */
function overlaps(a_range, a_part) {
  const r = a_range.cloneRange();
  const startsBefore = r.compareBoundaryPoints(Range.START_TO_START, a_part) <= 0;
  const endsAfter = r.compareBoundaryPoints(Range.END_TO_END, a_part) >= 0;
  if (startsBefore && endsAfter) return true; // 要素の全体を含む（空の段落も含める）
  if (!startsBefore) {
    if (r.compareBoundaryPoints(Range.END_TO_START, a_part) >= 0) return false; // 範囲が要素の後ろから始まる
  } else {
    r.setStart(a_part.startContainer, a_part.startOffset);
  }
  if (!endsAfter) {
    if (r.compareBoundaryPoints(Range.START_TO_END, a_part) <= 0) return false; // 範囲が要素の前で終わる
  } else {
    r.setEnd(a_part.endContainer, a_part.endOffset);
  }
  const f = r.cloneContents();
  return '' !== clean(f.textContent) || !!f.querySelector('img');
}

/**
 * 要素の中身の範囲。
 * @param {Node} a_el 要素
 * @param {Node} [a_until] この子の手前まで（無ければ最後まで）
 * @returns {Range}
 */
function contentsRange(a_el, a_until) {
  const r = document.createRange();
  r.selectNodeContents(a_el);
  if (a_until) r.setEndBefore(a_until);
  return r;
}

/**
 * 1行分の内容（mde の ClipboardHtmlBuilder.Row）。
 * @returns {{text:string, html:string, extra:string, rawTr:string|null, paragraph:boolean, imageHeight:number}}
 */
const newRow = (a_paragraph) => ({ text: '', html: '', extra: '', rawTr: null, paragraph: a_paragraph, imageHeight: 0 });

/**
 * 段落等の中身（文字・書式・画像）を、行の HTML と文字に加える（mde の AppendInline）。
 * @param {object} a_row 行（newRow）
 * @param {NodeList|Node[]} a_nodes 子のノード
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 * @param {boolean} a_outerMore このノードの並びの後ろにも内容が続くか
 */
function appendInlines(a_row, a_nodes, a_imageUrl, a_outerMore) {
  const nodes = [...a_nodes].filter((n) => !(1 === n.nodeType && BLOCK_TAGS.has(n.tagName) && 'DIV' !== n.tagName));
  nodes.forEach((node, k) => {
    const more = k + 1 < nodes.length || a_outerMore;
    if (3 === node.nodeType) {
      const t = clean(node.data).replace(/ /g, ' ');
      a_row.text += t;
      a_row.html += esc(t);
      return;
    }
    if (1 !== node.nodeType) return;
    const tag = node.tagName;
    const wrap = (a_open, a_close) => {
      a_row.html += a_open;
      appendInlines(a_row, node.childNodes, a_imageUrl, more);
      a_row.html += a_close;
    };
    switch (tag) {
      case 'BR':
        if (node === node.parentNode.lastChild && !node.dataset.soft) break; // 空の行を表示するための <br>
        a_row.html += '<br>';
        a_row.text += '\n';
        break;
      case 'IMG': appendImage(a_row, node, a_imageUrl, more); break;
      case 'INPUT': break;
      case 'STRONG': case 'B': wrap('<b>', '</b>'); break;
      case 'EM': case 'I': wrap('<i>', '</i>'); break;
      case 'DEL': case 'S': case 'STRIKE': wrap('<s>', '</s>'); break;
      case 'U': wrap('<u>', '</u>'); break;
      case 'MARK': wrap('<mark>', '</mark>'); break;
      case 'CODE': wrap('<code style="font-family:Consolas,monospace;background:#f0efe9;padding:0 3pt;">', '</code>'); break;
      case 'A': {
        // 外部のリンク（https: 等）だけをリンクにする（相対パスのリンクは、貼り付け先では開けないため文字にする）
        const href = node.getAttribute('href') || '';
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) wrap(`<a href="${esc(href)}">`, '</a>');
        else appendInlines(a_row, node.childNodes, a_imageUrl, more);
        break;
      }
      default:
        appendInlines(a_row, node.childNodes, a_imageUrl, more);
    }
  });
}

/**
 * 画像を行に加える（mde の AppendImage）。画像のファイルの場所が分からなければ「[画像: 代替テキスト]」にする。
 * @param {object} a_row 行
 * @param {HTMLImageElement} a_img 画像
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 * @param {boolean} a_more 後ろに内容が続くか（続くなら改行する）
 */
function appendImage(a_row, a_img, a_imageUrl, a_more) {
  const url = a_imageUrl(a_img);
  if (!url) {
    const placeholder = `[画像${a_img.alt ? `: ${a_img.alt}` : ''}]`;
    a_row.text += placeholder;
    a_row.html += esc(placeholder);
    return;
  }
  a_row.html += `<img src="${esc(url)}"${a_img.width ? ` width="${a_img.width}"` : ''}>`;
  if (a_more) a_row.html += '<br>';
  a_row.text += '[画像]';
  if (a_img.height) a_row.imageHeight = Math.max(a_row.imageHeight, a_img.height);
}

/**
 * 表の行の HTML（罫線付き。1つ目の行は th）とタブ区切りの文字（mde の BuildTableRowsHtml・TableToTsv）。
 * @param {HTMLTableRowElement[]} a_rows 行
 * @param {number} a_firstRowIndex 1つ目の行の、表の中での番号（0 なら見出しの行として th にする）
 * @param {number} a_minCol 最初の列
 * @param {number} a_maxCol 最後の列
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 * @returns {{html:string, text:string}}
 */
function tableRows(a_rows, a_firstRowIndex, a_minCol, a_maxCol, a_imageUrl) {
  let html = '';
  const lines = [];
  a_rows.forEach((tr, k) => {
    const tag = 0 === a_firstRowIndex + k ? 'th' : 'td';
    const cells = [...tr.cells].slice(a_minCol, a_maxCol + 1);
    html += '<tr>';
    const texts = [];
    for (const cell of cells) {
      const row = newRow(false);
      appendInlines(row, cell.childNodes, a_imageUrl, false);
      html += `<${tag} style="${CELL_STYLE}">${row.html}</${tag}>`;
      texts.push(row.text.replace(/[\t\r\n]/g, ' ').trim());
    }
    html += '</tr>';
    lines.push(texts.join('\t'));
  });
  return { html, text: lines.join('\n') };
}

/**
 * 表全体を、罫線付きの HTML とタブ区切りの文字、Markdown にする（右クリックの「表をコピー」。mde の CopyTable）。
 * @param {HTMLTableElement} a_table 表
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 * @returns {{text:string, html:string, markdown:string}}
 */
export function buildTableCopy(a_table, a_imageUrl) {
  const rows = [...a_table.rows];
  const maxCol = Math.max(0, ...rows.map((r) => r.cells.length)) - 1;
  const { html, text } = tableRows(rows, 0, 0, maxCol, a_imageUrl);
  return { text, html: `${TABLE_OPEN}${html}</table>`, markdown: serializeBlock(a_table, {}) };
}

/**
 * 「Excel用にコピー」の内容を作る（mde と同じ）。
 *  - 表の中を選んでいる場合：選んだセルの範囲（範囲の端が表の外なら表全体）を、罫線付きの表にする
 *  - それ以外：見出し・段落・項目・コードブロック・水平線・画像・表を、1行ずつ、1列の表の行にする
 *    （Excel では1行1セルに分かれて貼り付く）。段落等の前後には空の行を入れ、画像の後ろには画像の高さの分の
 *    空の行を入れる（Excel は画像に合わせて行を高くしないため）。
 * 1つの段落の中の一部だけを選んでいる場合は null（通常のコピーをする）。
 * @param {Range} a_range 選んだ範囲
 * @param {HTMLElement} a_root 編集領域
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 * @returns {{text:string, html:string}|null}
 */
export function buildExcelCopy(a_range, a_root, a_imageUrl) {
  const cellOf = (a_node) => {
    const el = 1 === a_node.nodeType ? a_node : a_node.parentElement;
    const cell = el && el.closest('td,th');
    return cell && a_root.contains(cell) ? cell : null;
  };
  // 表の中を選んでいる場合（mde の TableEditor.TryCopySelectionForExcel）
  const startCell = cellOf(a_range.startContainer);
  const endCell = cellOf(a_range.endContainer);
  const anyCell = startCell || endCell;
  if (anyCell) {
    const table = anyCell.closest('table');
    const rows = [...table.rows];
    let r0 = 0;
    let r1 = rows.length - 1;
    let c0 = 0;
    let c1 = Math.max(0, ...rows.map((r) => r.cells.length)) - 1;
    if (startCell && endCell && startCell.closest('table') === table && endCell.closest('table') === table) {
      const ra = rows.indexOf(startCell.parentElement);
      const rb = rows.indexOf(endCell.parentElement);
      r0 = Math.min(ra, rb);
      r1 = Math.max(ra, rb);
      c0 = Math.min(startCell.cellIndex, endCell.cellIndex);
      c1 = Math.max(startCell.cellIndex, endCell.cellIndex);
    }
    const { html, text } = tableRows(rows.slice(r0, r1 + 1), r0, c0, c1, a_imageUrl);
    return { text, html: `${TABLE_OPEN}${html}</table>` };
  }

  // 1つの段落の中の一部だけを選んでいる場合は、通常のコピーにする（段落の全体を選んでいれば対象にする）
  const anc = 1 === a_range.commonAncestorContainer.nodeType
    ? a_range.commonAncestorContainer : a_range.commonAncestorContainer.parentElement;
  const block = anc.closest('p,h1,h2,h3,h4,h5,h6,li,pre,.md-raw');
  if (block && a_root.contains(block)) {
    const whole = clean(block.textContent).trim();
    if (clean(a_range.toString()).trim() !== whole) return null;
  }

  const rows = [];
  collectRows(a_root.children, a_range, 0, rows, a_imageUrl);
  if (0 === rows.length) return null;
  const blankRow = '<tr><td style="padding:4px 8px;white-space:nowrap;">&nbsp;</td></tr>';
  let html = TABLE_OPEN;
  const lines = [];
  rows.forEach((row, i) => {
    const prevHadImage = i > 0 && rows[i - 1].imageHeight > 0;
    if (i > 0 && !prevHadImage && (row.paragraph || rows[i - 1].paragraph)) html += blankRow;
    if (null !== row.rawTr) html += row.rawTr;
    else html += `<tr><td style="padding:4px 8px;white-space:nowrap;${row.extra}">${row.html}</td></tr>`;
    lines.push(row.text);
    if (row.imageHeight > 0) {
      const n = Math.max(1, Math.ceil(row.imageHeight / EXCEL_DEFAULT_ROW_HEIGHT_PX));
      for (let k = 0; k < n + 1; k++) html += blankRow;
    }
  });
  html += '</table>';
  return { text: lines.join('\n'), html };
}

/**
 * 選んだ範囲と重なるブロックを、1行ずつの内容にする（mde の CollectRowsInBlocks）。
 * @param {HTMLCollection|Element[]} a_blocks ブロック要素の並び
 * @param {Range} a_range 選んだ範囲
 * @param {number} a_depth リストの深さ
 * @param {object[]} a_rows 行を加える配列
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 */
function collectRows(a_blocks, a_range, a_depth, a_rows, a_imageUrl) {
  for (const el of a_blocks) {
    const tag = el.tagName;
    if ('HR' === tag) {
      if (!a_range.intersectsNode(el)) continue;
      const row = newRow(true);
      row.extra = 'border-top:2px solid #999999;padding:2px 8px;';
      row.html = '&nbsp;';
      row.text = '-'.repeat(40);
      a_rows.push(row);
      continue;
    }
    if (!overlaps(a_range, contentsRange(el))) continue;
    if ('UL' === tag || 'OL' === tag) {
      collectListRows(el, a_range, a_depth, a_rows, a_imageUrl);
    } else if ('BLOCKQUOTE' === tag) {
      collectRows(el.children, a_range, a_depth, a_rows, a_imageUrl);
    } else if ('TABLE' === tag) {
      const rows = [...el.rows];
      const maxCol = Math.max(0, ...rows.map((r) => r.cells.length)) - 1;
      const { html, text } = tableRows(rows, 0, 0, maxCol, a_imageUrl);
      const row = newRow(false);
      row.rawTr = html;
      row.text = text;
      a_rows.push(row);
    } else if ('PRE' === tag || el.classList.contains('md-raw')) {
      const code = clean(el.innerText).replace(/ /g, ' ').replace(/\n$/, '');
      const row = newRow(true);
      row.extra = 'font-family:Consolas,monospace;font-size:9.5pt;white-space:pre-wrap;';
      row.html = esc(code).replace(/\n/g, '<br>');
      row.text = code;
      a_rows.push(row);
    } else {
      const row = newRow(true);
      const m = tag.match(/^H([1-6])$/);
      if (m) row.extra = `font-weight:bold;font-size:${HEADING_PT[Number(m[1]) - 1]}pt;`;
      appendInlines(row, el.childNodes, a_imageUrl, false);
      a_rows.push(row);
    }
  }
}

/**
 * リストの項目を、1項目1行の内容にする（mde の CollectListRows）。記号は「・ 」「1. 」「☑ 」「☐ 」、
 * 入れ子は全角の空白2つずつ字下げする。
 * @param {HTMLElement} a_list ul・ol
 * @param {Range} a_range 選んだ範囲
 * @param {number} a_depth 深さ
 * @param {object[]} a_rows 行を加える配列
 * @param {(img: HTMLImageElement) => string|null} a_imageUrl 画像のファイルの場所を返す関数
 */
function collectListRows(a_list, a_range, a_depth, a_rows, a_imageUrl) {
  const ordered = 'OL' === a_list.tagName;
  let n = ordered ? parseInt(a_list.getAttribute('start') || '1', 10) - 1 : 0;
  for (const li of a_list.children) {
    if ('LI' !== li.tagName) continue;
    n++;
    const firstBlock = [...li.children].find((c) => BLOCK_TAGS.has(c.tagName) && 'DIV' !== c.tagName);
    let row = null;
    if (overlaps(a_range, contentsRange(li, firstBlock))) {
      row = newRow(false);
      const box = li.querySelector(':scope > input[type=checkbox]');
      const marker = box ? (box.checked ? '☑ ' : '☐ ') : ordered ? `${n}. ` : '・ ';
      const prefix = '　　'.repeat(a_depth) + marker;
      row.text = prefix;
      row.html = esc(prefix);
      const own = [];
      for (const c of li.childNodes) {
        if (c === firstBlock) break;
        own.push(c);
      }
      appendInlines(row, own, a_imageUrl, false);
      a_rows.push(row);
    }
    for (const b of li.children) {
      if ('UL' === b.tagName || 'OL' === b.tagName) {
        collectListRows(b, a_range, a_depth + 1, a_rows, a_imageUrl);
      } else if (BLOCK_TAGS.has(b.tagName) && 'DIV' !== b.tagName && overlaps(a_range, contentsRange(b))) {
        // 項目の中の続きの段落：項目の行に改行して続ける
        if (!row) {
          row = newRow(false);
          a_rows.push(row);
        } else {
          row.html += '<br>&nbsp;&nbsp;';
          row.text += '\n  ';
        }
        if ('PRE' === b.tagName) {
          const code = clean(b.innerText).replace(/\n$/, '');
          row.html += esc(code).replace(/\n/g, '<br>');
          row.text += code;
        } else {
          appendInlines(row, b.childNodes, a_imageUrl, false);
        }
      }
    }
  }
}

// ===== 貼り付け：Excel 等の表 =====

/**
 * HTML の中の表を、セルの2次元の配列にする（mde の TryParseHtmlTable）。表だけの HTML（表の外に文字が
 * 無いもの）の場合だけ。セルの中の改行は「\n」にする。
 * Excel でコピーした範囲に画像（図）がある場合、Excel は画像を一時ファイル（file:///…/clip_image001.png）にして、
 * 画像の左上があるセルの中に <img> で書くので、その参照先と表示の幅もセルごとに取り出す（貼り付ける時に、
 * ホストが一時フォルダへコピーする。editor.js の pasteData）。
 * 文字だけの場合は、2行以上か2列以上の時だけ表にする（1つのセルだけなら、文字として貼る）。
 * @param {string} a_html クリップボードの HTML
 * @returns {{text:string, images:{src:string, width:number}[]}[][]|null}
 */
export function tableFromHtml(a_html) {
  if (!a_html || !/<table/i.test(a_html)) return null;
  const doc = new DOMParser().parseFromString(a_html, 'text/html');
  const tables = [...doc.body.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table'));
  if (1 !== tables.length) return null;
  const table = tables[0];
  if (doc.body.textContent.replace(/\s+/g, '') !== table.textContent.replace(/\s+/g, '')) return null;
  const rows = [];
  let hasImage = false;
  for (const tr of table.rows) {
    const cells = [...tr.cells].map((cell) => {
      const images = [...cell.querySelectorAll('img')].map((img) => ({
        src: img.getAttribute('src') || '',
        width: parseInt(img.getAttribute('width') || '0', 10) || 0,
      })).filter((i) => i.src);
      if (images.length) hasImage = true;
      for (const br of cell.querySelectorAll('br')) br.replaceWith('\n');
      return { text: cell.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim(), images };
    });
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  return rows.length >= 2 || cols >= 2 || hasImage ? rows : null;
}

/**
 * 表のセルの画像の参照先（Excel の一時ファイル等。file:///…）を集める（重複なし）。
 * @param {({text:string, images?:{src:string}[]}|string)[][]} a_rows tableFromHtml・tableFromTsv の結果
 * @returns {string[]}
 */
export function imageSourcesInRows(a_rows) {
  const srcs = new Set();
  for (const row of a_rows) for (const cell of row) for (const img of (cell && cell.images) || []) srcs.add(img.src);
  return [...srcs];
}

/**
 * タブ区切りの文字（Excel のコピー）を、セルの文字の2次元の配列にする（mde の ParseTsv。Excel と同じく、
 * 「"」で囲んだセルの中の改行・タブ・「""」も読む）。タブを含み、どの行も同じ数（2以上）のセルの場合だけ。
 * @param {string} a_text クリップボードの文字
 * @returns {string[][]|null}
 */
export function tableFromTsv(a_text) {
  if (!a_text || !a_text.includes('\t')) return null;
  let text = normalizeNewlines(a_text);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const rows = [[]];
  let i = 0;
  let cell = '';
  let cellStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (cellStart && '"' === ch) {
      // 「"」で囲んだセル（閉じの「"」の直後がタブ・改行・終わりの場合だけ）
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < text.length) {
        if ('"' === text[j]) {
          if ('"' === text[j + 1]) { v += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        v += text[j++];
      }
      if (closed && (j >= text.length || '\t' === text[j] || '\n' === text[j])) {
        cell = v;
        i = j;
        cellStart = false;
        continue;
      }
    }
    if ('\t' === ch) {
      rows[rows.length - 1].push(cell);
      cell = '';
      cellStart = true;
    } else if ('\n' === ch) {
      rows[rows.length - 1].push(cell);
      rows.push([]);
      cell = '';
      cellStart = true;
    } else {
      cell += ch;
      cellStart = false;
    }
    i++;
  }
  rows[rows.length - 1].push(cell);
  const cols = rows[0].length;
  if (cols < 2 || rows.some((r) => r.length !== cols)) return null;
  return rows;
}

/**
 * セルの2次元の配列を、Markdown の表にする（1つ目の行を見出しの行にする。セルの中の改行は <br>）。
 * 画像のあるセルは、文字の後ろに <img src="…" width="…"> を加える（Excel での大きさを保つ）。
 * @param {({text:string, images?:{src:string, width:number}[]}|string)[][]} a_rows セル
 * @param {Map<string,string>} [a_urls] 画像の参照先 → 貼り付けた画像の URL（無い画像は入れない）
 * @returns {string}
 */
export function rowsToMarkdownTable(a_rows, a_urls) {
  const cols = Math.max(...a_rows.map((r) => r.length));
  const cell = (a_cell) => cellMarkdown(a_cell, a_urls).replace(/\n/g, '<br>').replace(/\|/g, '\\|');
  const line = (a_row) => `| ${Array.from({ length: cols }, (_, k) => cell(a_row[k])).join(' | ')} |`;
  return [line(a_rows[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...a_rows.slice(1).map(line)].join('\n');
}

/**
 * セル1つ分の Markdown（文字と画像。改行は「\n」のまま）。
 * @param {{text:string, images?:{src:string, width:number}[]}|string|undefined} a_cell セル
 * @param {Map<string,string>} [a_urls] 画像の参照先 → 貼り付けた画像の URL
 * @returns {string}
 */
export function cellMarkdown(a_cell, a_urls) {
  if (null == a_cell) return '';
  const text = 'string' === typeof a_cell ? a_cell : a_cell.text;
  const parts = [escapeText(text || '').split('\n').map((l) => l.trim()).join('\n')].filter((t) => '' !== t);
  for (const img of ('string' === typeof a_cell ? null : a_cell.images) || []) {
    const url = a_urls && a_urls.get(img.src);
    if (url) parts.push(`<img src="${url}"${img.width ? ` width="${img.width}"` : ''}>`);
  }
  return parts.join('\n');
}
