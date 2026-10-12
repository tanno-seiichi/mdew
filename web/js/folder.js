// mdew：フォルダビュー（mde のフォルダビューと同じ内容。メニュー「ファイル」→「フォルダを開く...」で開いた時だけ表示する）。
//
//  - フォルダの中のサブフォルダと Markdown ファイル（.md・.markdown）を木の形で表示する。並び順・対象は mde と同じ
//    （各フォルダの中でサブフォルダ、ファイルの順。名前は数字を数として並べる。名前が「.」で始まるフォルダは出さない）。
//    一覧はホスト（C#）が作る（listDir → dirList。Program.cs の ListMarkdownEntries）。
//  - フォルダは、初めて開いた時に中身を読み込む（最初は一番上のフォルダだけ開いた状態）。
//  - ファイルをクリックすると、そのファイルを開く（main.js の onOpenFile）。
//  - 保存していない変更があるファイルは、名前の先頭に「* 」を付ける（main.js が isDirty で教える）。
//  - 今開いているファイルは選択した色、検索で見つかったファイル（とそれを含むフォルダ）は黄色にする。

/**
 * パスを比べるためのキー（Windows のパスは大文字・小文字を区別しないので、小文字にそろえる）。
 * @param {string} a_path パス
 * @returns {string}
 */
export function pathKey(a_path) {
  return (a_path || '').toLowerCase();
}

/**
 * パスの最後の部分（ファイル名・フォルダ名）。
 * @param {string} a_path パス
 * @returns {string}
 */
export function baseName(a_path) {
  const parts = (a_path || '').split(/[\\/]/).filter((p) => p);
  return parts.length ? parts[parts.length - 1] : a_path;
}

/** フォルダビュー。木の各項目（node）は {path, name, isDir, children, loaded, expanded, li, row, label} を持つ。 */
export class FolderView {
  /**
   * @param {HTMLElement} a_list 木を表示する要素（ul）
   * @param {object} a_handlers 呼び出し元への通知
   * @param {(path: string) => void} a_handlers.onOpenFile ファイルがクリックされた
   * @param {(path: string) => Promise<{dirs: string[], files: string[]}>} a_handlers.listDir フォルダの中身を得る
   * @param {(path: string) => boolean} a_handlers.isDirty そのファイルに保存していない変更があるか
   */
  constructor(a_list, a_handlers) {
    this.m_list = a_list;
    this.m_handlers = a_handlers;
    /** 一番上のフォルダの項目（フォルダを開いていなければ null）。 */
    this.m_root = null;
    /** パスのキー（pathKey）→ 項目。読み込み済みの項目だけ。 */
    this.m_nodes = new Map();
    /** 今開いているファイルのパス。 */
    this.m_current = null;
    /** 検索で見つかったファイル・フォルダのパスのキー。 */
    this.m_hits = new Set();
  }

  /** フォルダを開いているか。 */
  get isOpen() {
    return null !== this.m_root;
  }

  /** 開いているフォルダのパス（開いていなければ null）。 */
  get rootPath() {
    return this.m_root ? this.m_root.path : null;
  }

  /**
   * フォルダを開く（木を作り直す。一番上のフォルダだけ開いた状態にする）。
   * @param {string} a_path フォルダのパス
   * @param {string} a_name 表示する名前
   * @returns {Promise<void>} 一番上のフォルダの中身を読み込み終えたら解決する
   */
  async open(a_path, a_name) {
    this.m_nodes.clear();
    this.m_hits.clear();
    this.m_list.replaceChildren();
    this.m_root = this.createNode(a_path, a_name, true, 0);
    this.m_list.appendChild(this.m_root.li);
    await this.expand(this.m_root);
  }

  /**
   * 項目を作る（画面の要素も作る）。
   * @param {string} a_path パス
   * @param {string} a_name 表示する名前
   * @param {boolean} a_isDir フォルダか
   * @param {number} a_depth 深さ（一番上のフォルダが 0。字下げに使う）
   * @returns {object} 項目
   */
  createNode(a_path, a_name, a_isDir, a_depth) {
    const node = { path: a_path, name: a_name, isDir: a_isDir, children: null, loaded: false, expanded: false };
    node.li = document.createElement('li');
    node.row = node.li.appendChild(document.createElement('div'));
    node.row.className = 'row';
    node.row.style.paddingLeft = `${4 + a_depth * 14}px`;
    node.row.title = a_path;
    const toggle = node.row.appendChild(document.createElement('span'));
    toggle.className = 'toggle';
    toggle.textContent = a_isDir ? '▸' : '';
    node.label = node.row.appendChild(document.createElement('span'));
    node.label.className = 'name';
    node.depth = a_depth;
    // クリック：フォルダは開く・閉じる、ファイルは開く（mousedown で既定の動作を止め、編集中のカーソル位置を保つ）
    node.row.addEventListener('mousedown', (e) => e.preventDefault());
    node.row.addEventListener('click', () => {
      if (node.isDir) this.toggle(node);
      else this.m_handlers.onOpenFile(node.path);
    });
    this.m_nodes.set(pathKey(a_path), node);
    this.updateRow(node);
    return node;
  }

  /**
   * フォルダの中身を読み込む（初めての時だけ）。
   * @param {object} a_node フォルダの項目
   */
  async load(a_node) {
    if (a_node.loaded) return;
    a_node.loaded = true;
    const { dirs, files } = await this.m_handlers.listDir(a_node.path);
    a_node.children = [
      ...dirs.map((p) => this.createNode(p, baseName(p), true, a_node.depth + 1)),
      ...files.map((p) => this.createNode(p, baseName(p), false, a_node.depth + 1)),
    ];
    const ul = document.createElement('ul');
    for (const child of a_node.children) ul.appendChild(child.li);
    a_node.li.appendChild(ul);
    a_node.ul = ul;
    ul.hidden = !a_node.expanded;
  }

  /**
   * フォルダを開く（中身を表示する）。
   * @param {object} a_node フォルダの項目
   */
  async expand(a_node) {
    a_node.expanded = true;
    await this.load(a_node);
    if (a_node.ul) a_node.ul.hidden = false;
    this.updateRow(a_node);
  }

  /**
   * フォルダを開く・閉じる。
   * @param {object} a_node フォルダの項目
   */
  async toggle(a_node) {
    if (a_node.expanded) {
      a_node.expanded = false;
      if (a_node.ul) a_node.ul.hidden = true;
      this.updateRow(a_node);
    } else {
      await this.expand(a_node);
    }
  }

  /**
   * 項目の表示（開閉の印・「* 」・選択・検索の色）を、今の状態に合わせる。
   * @param {object} a_node 項目
   */
  updateRow(a_node) {
    if (a_node.isDir) a_node.row.firstChild.textContent = a_node.expanded ? '▾' : '▸';
    const dirty = !a_node.isDir && this.m_handlers.isDirty(a_node.path);
    a_node.label.textContent = (dirty ? '* ' : '') + a_node.name;
    a_node.row.classList.toggle('current', pathKey(a_node.path) === pathKey(this.m_current));
    a_node.row.classList.toggle('hit', this.m_hits.has(pathKey(a_node.path)));
  }

  /** すべての項目の表示を更新する（「* 」の付け外し等）。 */
  refresh() {
    for (const node of this.m_nodes.values()) this.updateRow(node);
  }

  /**
   * そのパスの項目が、読み込み済みの木の中にあるか。
   * @param {string} a_path パス
   * @returns {boolean}
   */
  has(a_path) {
    return this.m_nodes.has(pathKey(a_path));
  }

  /**
   * パスが、開いているフォルダの中にあるか。
   * @param {string} a_path パス
   * @returns {boolean}
   */
  contains(a_path) {
    if (!this.m_root || !a_path) return false;
    const root = pathKey(this.m_root.path).replace(/[\\/]+$/, '');
    const key = pathKey(a_path);
    return key.startsWith(`${root}\\`) || key.startsWith(`${root}/`);
  }

  /**
   * 開いているフォルダから見た相対パス（フォルダの外なら null）。
   * @param {string} a_path パス
   * @returns {string|null}
   */
  relativePath(a_path) {
    if (!this.contains(a_path)) return null;
    return a_path.slice(this.m_root.path.replace(/[\\/]+$/, '').length + 1);
  }

  /**
   * パスの項目を表示する（途中のフォルダを開いて読み込む）。フォルダの外なら null。
   * @param {string} a_path パス
   * @returns {Promise<object|null>} 項目
   */
  async reveal(a_path) {
    const rel = this.relativePath(a_path);
    if (null === rel) return null;
    const parts = rel.split(/[\\/]/);
    let node = this.m_root;
    let path = this.m_root.path.replace(/[\\/]+$/, '');
    for (let i = 0; i < parts.length; i++) {
      await this.expand(node);
      path += `\\${parts[i]}`;
      const next = this.m_nodes.get(pathKey(path));
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /**
   * 今開いているファイルを選択した色にし、見える位置までスクロールする（フォルダの中のファイルだけ）。
   * @param {string|null} a_path 今開いているファイルのパス（新規の文書は null）
   */
  async setCurrent(a_path) {
    this.m_current = a_path;
    this.refresh();
    if (!a_path || !this.contains(a_path)) return;
    const node = await this.reveal(a_path);
    if (node) node.row.scrollIntoView({ block: 'nearest' });
  }

  /**
   * フォルダの中身を読み込み直す（保存で新しいファイルができた時等）。読み込み済みのフォルダだけ。
   * 開いているフォルダの状態は保つ。
   * @param {string} a_dirPath フォルダのパス
   */
  async reload(a_dirPath) {
    const node = this.m_nodes.get(pathKey(a_dirPath));
    if (!node || !node.loaded) return;
    const expanded = [...this.m_nodes.values()].filter((n) => n.isDir && n.expanded && n !== node).map((n) => n.path);
    for (const child of node.children || []) this.forget(child);
    if (node.ul) node.ul.remove();
    node.ul = null;
    node.loaded = false;
    node.children = null;
    if (node.expanded) await this.expand(node);
    for (const p of expanded) {
      const n = this.m_nodes.get(pathKey(p));
      if (n) await this.expand(n);
    }
    this.refresh();
  }

  /**
   * 項目（とその中の項目）を、パスの一覧から消す。
   * @param {object} a_node 項目
   */
  forget(a_node) {
    this.m_nodes.delete(pathKey(a_node.path));
    for (const child of a_node.children || []) this.forget(child);
  }

  /**
   * 検索で見つかったファイルと、それを含むフォルダを黄色にする（含むフォルダは開いて表示する）。
   * @param {string[]} a_paths 見つかったファイルのパス
   */
  async setSearchHits(a_paths) {
    this.m_hits.clear();
    for (const p of a_paths) {
      this.m_hits.add(pathKey(p));
      const rel = this.relativePath(p);
      if (null === rel) continue;
      let dir = this.m_root.path.replace(/[\\/]+$/, '');
      this.m_hits.add(pathKey(dir));
      const parts = rel.split(/[\\/]/);
      for (let i = 0; i < parts.length - 1; i++) {
        dir += `\\${parts[i]}`;
        this.m_hits.add(pathKey(dir));
      }
    }
    for (const p of a_paths) await this.reveal(p);
    this.refresh();
  }

  /** 検索の黄色を消す。 */
  clearSearchHits() {
    if (!this.m_hits.size) return;
    this.m_hits.clear();
    this.refresh();
  }
}
