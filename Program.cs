using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace mdew
{
    /// <summary>
    /// mde の HTML 版。画面はすべて HTML（web フォルダ）で作り、この C# 側は WebView2 を載せた入れ物として、
    /// ファイルを開く・保存するなど OS とのやり取りだけを担当する。
    /// HTML 側とは WebView2 の postMessage で JSON をやり取りする（web\js\main.js 冒頭のコメント参照）。
    /// </summary>
    public class MainWindow : Window
    {
        /// <summary>画面（web フォルダ）を読み込む仮想ホスト名（https://app.mdew/index.html）。</summary>
        private const string APP_HOST = "app.mdew";
        /// <summary>文書内の相対パスの画像を読み込む仮想ホスト名（ServeDocumentResource 参照）。</summary>
        private const string DOC_HOST = "doc.mdew";
        /// <summary>貼り付けた画像を、保存するまでの間置いておく一時フォルダの仮想ホスト名
        /// （web\js\editor.js の onPaste、web\js\main.js 参照）。</summary>
        private const string TMP_HOST = "tmp.mdew";
        /// <summary>貼り付けた画像のファイル名の先頭（clipboard_image_1.png 等。mde と同じ）。</summary>
        private const string PASTED_IMAGE_BASE_NAME = "clipboard_image";

        /// <summary>画面を表示する WebView2。</summary>
        private readonly WebView2 m_webView = new WebView2();
        /// <summary>開いているファイルのパス。新規（未保存）は null。</summary>
        private string m_currentPath;
        /// <summary>保存していない変更があるか（HTML 側から dirty で知らされる）。</summary>
        private bool m_isDirty;
        /// <summary>保存時の改行を CRLF にするか（読み込んだファイルに合わせる。新規は CRLF）。</summary>
        private bool m_useCrLf = true;
        /// <summary>保存時に UTF-8 の BOM を付けるか（読み込んだファイルに合わせる。新規は付けない）。</summary>
        private bool m_hasBom;
        /// <summary>閉じる時の「破棄して閉じますか」に「はい」と答えたか（確認を 2 回出さないため）。</summary>
        private bool m_closeConfirmed;
        /// <summary>開いているファイルのフォルダ（相対パスの画像の基準）。</summary>
        private string m_docFolder;
        /// <summary>画像の URL に入れる世代番号（ファイルを開き直すたびに増やす。SetDocumentFolder 参照）。</summary>
        private int m_docGeneration;
        /// <summary>起動時引数で指定されたファイルのパス（開いた後は null）。</summary>
        private string m_startupPath;
        /// <summary>「新規」で開いたウィンドウの位置・サイズ（起動時引数 --placement=。OpenNewWindow 参照）。</summary>
        private readonly WindowBounds m_startupBounds;
        /// <summary>「新規」で開いたウィンドウを最大化して開くか。</summary>
        private readonly bool m_startupMaximized;
        /// <summary>次回起動時に引き継ぐ設定（ウィンドウの位置・サイズ等）。</summary>
        private readonly AppSettings m_settings = AppSettings.Load();
        /// <summary>このウィンドウ専用の、貼り付けた画像の一時フォルダ（閉じる時に削除する）。</summary>
        private readonly string m_tempImageDir = Path.Combine(Path.GetTempPath(), Program.AssemblyName, Guid.NewGuid().ToString("N"));

        /// <summary>ウィンドウを作る。WebView2 の準備は、ウィンドウが表示された後（Loaded）に行う。</summary>
        /// <param name="a_startupPath">起動時引数で指定されたファイルのパス（無ければ null）。</param>
        /// <param name="a_placement">起動時引数 --placement= の値（「新規」で開いた時だけ。無ければ null）。</param>
        public MainWindow(string a_startupPath, string a_placement)
        {
            m_startupPath = ResolveStartupPath(a_startupPath);
            m_startupBounds = ParsePlacement(a_placement, out m_startupMaximized);
            Title = $"{Program.AppName} v{Program.Version}";
            Width = 1100;
            Height = 800;
            Content = m_webView;
            Loaded += async (s, e) => await InitializeWebViewAsync();
            Closing += OnClosing;
            // 前回終了時のウィンドウの位置・サイズ・最大化状態を復元する（RestoreWindowPlacement 参照）。
            // 初回起動時（まだ保存されていない時）は画面の中央に表示する。
            if (null == m_settings.Window && null == m_startupBounds)
            {
                WindowStartupLocation = WindowStartupLocation.CenterScreen;
            }
            SourceInitialized += (s, e) => RestoreWindowPlacement();
            Closed += (s, e) => DeleteTempImages();
        }

        /// <summary>WebView2 を準備して画面（web\index.html）を表示する。ブラウザのキャッシュの削除、
        /// 仮想ホスト名の設定、HTML 側とのメッセージ・画像の要求・クリップボードの許可の受け付けを行う。</summary>
        /// <returns>準備が終わるまでの非同期処理。</returns>
        private async System.Threading.Tasks.Task InitializeWebViewAsync()
        {
            // WebView2 の作業用のデータ（キャッシュ・localStorage 等）は %LOCALAPPDATA%\<アセンブリ名>\WebView2 に置く
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await m_webView.EnsureCoreWebView2Async(env);
            var core = m_webView.CoreWebView2;

            // 画面側（web フォルダ）のファイルを更新した時に、前回読み込んだ古いファイルがブラウザの
            // キャッシュから使われてしまわないよう、起動のたびにキャッシュを消す。
            await core.Profile.ClearBrowsingDataAsync(
                CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage);

            // Ctrl+R での再読み込み等で編集中の内容が消えないよう、ブラウザ用のショートカットは無効にする。
            // （F12・Ctrl+Shift+I の開発者ツールも無効になるため、F12 は HTML 側から devTools で開く）
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;

            string webDir = Path.Combine(AppContext.BaseDirectory, "web");
            core.SetVirtualHostNameToFolderMapping(APP_HOST, webDir, CoreWebView2HostResourceAccessKind.Allow);
            // 文書内の画像（相対パス）は https://doc.mdew/<世代>/<相対パス> として要求されるので、
            // 開いているファイルのフォルダから読んで返す（ServeDocumentResource 参照）。
            core.AddWebResourceRequestedFilter($"https://{DOC_HOST}/*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter($"https://{TMP_HOST}/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeDocumentResource;
            // タイトルバー：HTML 側のタイトル（「* ファイル名」）の後ろに、アプリ名とバージョンを付ける
            core.DocumentTitleChanged += (s, e) => Title = $"{core.DocumentTitle} - {Program.AppName} v{Program.Version}";
            core.WebMessageReceived += OnWebMessage;
            // 右クリックのメニューの「貼り付け」で、画面側からクリップボードを読めるようにする
            // （許可しないと、読み取るたびに確認の表示が出る。web\js\editor.js の pasteFromClipboard 参照）
            core.PermissionRequested += (s, e) =>
            {
                if (CoreWebView2PermissionKind.ClipboardRead == e.PermissionKind)
                {
                    e.State = CoreWebView2PermissionState.Allow;
                }
            };
            core.ProcessFailed += (s, e) =>
            {
                // WebView2 側（ブラウザ・画面表示のプロセス）が異常終了した場合の記録
                ErrorLog.Write($"WebView2 のプロセスが異常終了：種類={e.ProcessFailedKind} 理由={e.Reason} 終了コード={e.ExitCode} {e.ProcessDescription}", null);
            };
            core.Navigate($"https://{APP_HOST}/index.html");
        }

        /// <summary>HTML 側へメッセージを送る（JSON にして postMessage する。web\js\main.js の host の message 参照）。</summary>
        /// <param name="a_message">メッセージ（cmd と、cmd ごとの値を持つ匿名型）。</param>
        private void Post(object a_message)
        {
            m_webView.CoreWebView2.PostWebMessageAsString(JsonSerializer.Serialize(a_message));
        }

        /// <summary>HTML 側からのメッセージを受け取る。
        /// 処理は WebView2 のイベントを抜けてから行う。WebView2 のイベントの中でファイルを開くダイアログや
        /// メッセージボックスを表示すると（入れ子のメッセージループ）、WebView2 が再入に対応していないため、
        /// 操作に反応しなくなったりアプリが落ちたりすることがある（Microsoft の WebView2 の資料
        /// 「Threading model for WebView2 apps」の Reentrancy の項で、遅らせて処理するよう案内されている）。</summary>
        /// <param name="a_sender">CoreWebView2。</param>
        /// <param name="a_args">受け取ったメッセージ（JSON の文字列）。</param>
        private void OnWebMessage(object a_sender, CoreWebView2WebMessageReceivedEventArgs a_args)
        {
            string json = a_args.TryGetWebMessageAsString();
            Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    HandleWebMessage(json);
                }
                catch (Exception ex)
                {
                    ErrorLog.Write("HTML 側からのメッセージの処理中にエラー", ex);
                    Post(new { cmd = "error", message = $"処理中にエラーが発生しました。\n{ex.Message}" });
                }
            }));
        }

        /// <summary>HTML 側からのメッセージを処理する（cmd ごとに振り分ける）。メッセージの一覧は web\js\main.js の冒頭のコメント参照。</summary>
        /// <param name="a_json">メッセージの JSON。</param>
        private void HandleWebMessage(string a_json)
        {
            using var doc = JsonDocument.Parse(a_json);
            var root = doc.RootElement;
            string cmd = root.GetProperty("cmd").GetString();
            switch (cmd)
            {
                case "ready":
                    // 画面側の設定（Debug ビルドの時は、ステータスバーに停止・入力遅延の回数を表示する）
                    Post(new { cmd = "init", debug = Program.IsDebugBuild });
                    OpenStartupPath();
                    // すぐに書き始められるよう、編集領域にキーボードの入力先を移す
                    m_webView.Focus();
                    Post(new { cmd = "focus" });
                    break;
                case "open":
                    var ofd = new OpenFileDialog
                    {
                        Filter = "Markdown ファイル (*.md;*.markdown)|*.md;*.markdown|すべてのファイル (*.*)|*.*",
                    };
                    if (true == ofd.ShowDialog(this))
                    {
                        LoadFile(ofd.FileName);
                    }
                    break;
                case "save":
                    var images = new System.Collections.Generic.List<string>();
                    if (root.TryGetProperty("images", out JsonElement imagesElement) && JsonValueKind.Array == imagesElement.ValueKind)
                    {
                        foreach (JsonElement item in imagesElement.EnumerateArray())
                        {
                            images.Add(item.GetString());
                        }
                    }
                    SaveFile(root.GetProperty("markdown").GetString(), root.GetProperty("saveAs").GetBoolean(), images);
                    break;
                case "dirty":
                    m_isDirty = root.GetProperty("value").GetBoolean();
                    break;
                case "newWindow":
                    OpenNewWindow();
                    break;
                case "imeOn":
                    ForceImeOn();
                    break;
                case "about":
                    // バージョン情報（このウィンドウの中央に、閉じるまで操作できない形で開く）
                    new dialog.AboutWindow { Owner = this }.ShowDialog();
                    break;
                case "devTools":
                    // F12：開発者ツール（ブラウザ用のショートカットを無効にしているため、ここから開く）
                    m_webView.CoreWebView2.OpenDevToolsWindow();
                    break;
                case "openUrl":
                    OpenUrl(root.GetProperty("url").GetString());
                    break;
                case "openRelative":
                    OpenRelativeFile(root.GetProperty("path").GetString());
                    break;
                case "pasteImage":
                    SavePastedImage(root.GetProperty("id").GetInt32(), root.GetProperty("type").GetString(),
                        root.GetProperty("data").GetString());
                    break;
                case "openFolder":
                    OpenFolder(root.TryGetProperty("relPath", out JsonElement relElement) && JsonValueKind.String == relElement.ValueKind
                        ? relElement.GetString() : null);
                    break;
                case "listDir":
                    ListDirectory(root.GetProperty("path").GetString());
                    break;
                case "openPath":
                    OpenPath(root.GetProperty("path").GetString());
                    break;
                case "readFolderFiles":
                    ReadFolderFiles(root.GetProperty("reqId").GetInt32(), root.GetProperty("root").GetString());
                    break;
                case "saveAll":
                    SaveAll(root.GetProperty("files"));
                    break;
            }
        }

        // ===== フォルダビュー・検索と置換・すべて保存（web\js\folder.js・find.js、main.js 参照） =====

        /// <summary>Markdown ファイルとして扱う拡張子（フォルダビューの一覧・フォルダ全体の検索の対象。mde と同じ）。</summary>
        private static readonly string[] MARKDOWN_EXTENSIONS = { ".md", ".markdown" };

        /// <summary>エクスプローラーと同じ並べ方（数字を数として比べる。「2」は「10」より前）で文字列を比べる。</summary>
        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        private static extern int StrCmpLogicalW(string a_x, string a_y);

        /// <summary>Markdown ファイルか（拡張子が .md・.markdown。大文字・小文字は区別しない）。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        /// <returns>Markdown ファイルなら true。</returns>
        private static bool IsMarkdownFile(string a_path)
        {
            string ext = Path.GetExtension(a_path);
            return Array.Exists(MARKDOWN_EXTENSIONS, e => string.Equals(e, ext, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>フォルダの直下のサブフォルダ（名前が「.」で始まるものは除く）と Markdown ファイルを、
        /// それぞれエクスプローラーと同じ順に並べて返す（mde の FolderTreeManager と同じ）。
        /// 読めないフォルダ（アクセスが拒否された等）は、読めた分だけを返す。</summary>
        /// <param name="a_dir">フォルダのパス。</param>
        /// <param name="a_dirs">サブフォルダのフルパスを受け取る。</param>
        /// <param name="a_files">Markdown ファイルのフルパスを受け取る。</param>
        private static void ListMarkdownEntries(string a_dir, out System.Collections.Generic.List<string> a_dirs,
            out System.Collections.Generic.List<string> a_files)
        {
            a_dirs = new System.Collections.Generic.List<string>();
            a_files = new System.Collections.Generic.List<string>();
            try
            {
                foreach (string d in Directory.EnumerateDirectories(a_dir))
                {
                    if (!Path.GetFileName(d).StartsWith(".")) a_dirs.Add(d);
                }
                foreach (string f in Directory.EnumerateFiles(a_dir))
                {
                    if (IsMarkdownFile(f)) a_files.Add(f);
                }
            }
            catch (Exception)
            {
                // 読めた分だけを返す
            }
            a_dirs.Sort((x, y) => StrCmpLogicalW(Path.GetFileName(x), Path.GetFileName(y)));
            a_files.Sort((x, y) => StrCmpLogicalW(Path.GetFileName(x), Path.GetFileName(y)));
        }

        /// <summary>メニュー「ファイル」→「フォルダを開く...」。フォルダを選ぶダイアログを出し、選ばれたら
        /// HTML 側に folderOpened を送ってから、そのフォルダのファイルを1つ開く（mde と同じく、今のファイルと
        /// 同じ相対パスのファイルがあればそれを、無ければフォルダの直下の最初のファイル。どちらも無ければ新規の文書）。
        /// 保存していない変更の確認は、HTML 側でダイアログを出す前に済ませている。</summary>
        /// <param name="a_relPath">今のファイルの、今のフォルダからの相対パス（フォルダを開いていない・新規の文書は null）。</param>
        private void OpenFolder(string a_relPath)
        {
            var dialog = new OpenFolderDialog { Title = "フォルダを開く" };
            if (true != dialog.ShowDialog(this))
            {
                return;
            }
            OpenFolderPath(dialog.FolderName, a_relPath);
        }

        /// <summary>フォルダを開く（HTML 側に folderOpened を送ってから、そのフォルダのファイルを1つ開く）。
        /// メニュー「フォルダを開く...」と、起動時引数でフォルダが指定された場合に使う。</summary>
        /// <param name="a_folder">フォルダのパス。</param>
        /// <param name="a_relPath">開きたいファイルの、フォルダからの相対パス（無ければ null。その場合や、そのファイルが
        /// 無い場合は、フォルダの直下の最初のファイルを開く）。</param>
        private void OpenFolderPath(string a_folder, string a_relPath)
        {
            string folder = a_folder.TrimEnd(Path.DirectorySeparatorChar);
            if (folder.EndsWith(":")) folder += Path.DirectorySeparatorChar; // ドライブの直下（C:\）
            string name = Path.GetFileName(folder);
            Post(new { cmd = "folderOpened", root = folder, name = string.IsNullOrEmpty(name) ? folder : name });
            string open = null;
            if (!string.IsNullOrEmpty(a_relPath))
            {
                string candidate = Path.Combine(folder, a_relPath);
                if (File.Exists(candidate)) open = candidate;
            }
            if (null == open)
            {
                ListMarkdownEntries(folder, out _, out var files);
                open = 0 < files.Count ? files[0] : null;
            }
            if (null != open)
            {
                LoadFile(open);
            }
            else
            {
                ResetToNewDocument();
            }
        }

        /// <summary>新規の文書（無題・空）にする。保存先・BOM・改行の設定も新規の文書と同じにする。</summary>
        private void ResetToNewDocument()
        {
            m_currentPath = null;
            m_hasBom = false;
            m_useCrLf = true;
            Post(new { cmd = "load", path = (string)null, name = "無題", docBase = (string)null, markdown = "" });
        }

        /// <summary>フォルダビューでフォルダを展開した時に、直下のサブフォルダと Markdown ファイルを返す（dirList を送る）。</summary>
        /// <param name="a_dir">フォルダのパス。</param>
        private void ListDirectory(string a_dir)
        {
            ListMarkdownEntries(a_dir, out var dirs, out var files);
            Post(new { cmd = "dirList", path = a_dir, dirs, files });
        }

        /// <summary>フォルダビュー・検索結果から、パスを指定してファイルを開く。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        private void OpenPath(string a_path)
        {
            if (!File.Exists(a_path))
            {
                Post(new { cmd = "error", message = $"ファイルが見つかりません。\n{a_path}" });
                return;
            }
            LoadFile(a_path);
        }

        /// <summary>ファイルを読んで、BOM を取り除き、改行を LF にそろえた文字列を返す。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        /// <returns>ファイルの内容。</returns>
        private static string ReadMarkdownText(string a_path)
        {
            byte[] bytes = File.ReadAllBytes(a_path);
            bool bom = bytes.Length >= 3 && 0xEF == bytes[0] && 0xBB == bytes[1] && 0xBF == bytes[2];
            return new UTF8Encoding(false).GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0)).Replace("\r\n", "\n");
        }

        /// <summary>フォルダ全体の検索・置換用に、フォルダ以下のすべての Markdown ファイルの内容を返す
        /// （folderFiles を送る）。並びはフォルダビューと同じ（各フォルダの中で、サブフォルダ、ファイルの順）。
        /// 名前が「.」で始まるフォルダは、フォルダビューと同じく対象にしない。読めないファイルは飛ばす。</summary>
        /// <param name="a_reqId">HTML 側が付けた要求の番号（そのまま返す）。</param>
        /// <param name="a_root">フォルダのパス。</param>
        private void ReadFolderFiles(int a_reqId, string a_root)
        {
            var result = new System.Collections.Generic.List<object>();
            void Walk(string a_dir)
            {
                ListMarkdownEntries(a_dir, out var dirs, out var files);
                foreach (string d in dirs) Walk(d);
                foreach (string f in files)
                {
                    try
                    {
                        result.Add(new { path = f, text = ReadMarkdownText(f) });
                    }
                    catch (Exception)
                    {
                        // 読めないファイルは飛ばす
                    }
                }
            }
            Walk(a_root);
            Post(new { cmd = "folderFiles", reqId = a_reqId, files = result });
        }

        /// <summary>メニュー「ファイル」→「すべて保存」。開いているファイル（current が true）は通常の保存と同じく
        /// 保存し（saved を送る）、それ以外のファイル（フォルダ全体の置換・ファイルの切り替えで、保存せずに
        /// 置いておいた内容）は、それぞれのファイルの BOM の有無・改行の種類に合わせて書き出す。
        /// 終わったら、保存できたファイルと失敗したファイルを savedAll で知らせる。</summary>
        /// <param name="a_files">保存するファイル（path・markdown・images・current）の配列。</param>
        private void SaveAll(JsonElement a_files)
        {
            var saved = new System.Collections.Generic.List<string>();
            var failed = new System.Collections.Generic.List<object>();
            foreach (JsonElement f in a_files.EnumerateArray())
            {
                string path = f.GetProperty("path").GetString();
                string markdown = f.GetProperty("markdown").GetString();
                var images = new System.Collections.Generic.List<string>();
                if (f.TryGetProperty("images", out JsonElement imagesElement) && JsonValueKind.Array == imagesElement.ValueKind)
                {
                    foreach (JsonElement item in imagesElement.EnumerateArray()) images.Add(item.GetString());
                }
                if (f.TryGetProperty("current", out JsonElement currentElement) && currentElement.GetBoolean())
                {
                    if (SaveFile(markdown, false, images, out string error)) saved.Add(path);
                    else failed.Add(new { path, message = error });
                    continue;
                }
                try
                {
                    WriteOtherFile(path, markdown);
                    saved.Add(path);
                }
                catch (Exception ex)
                {
                    failed.Add(new { path, message = ex.Message });
                }
            }
            Post(new { cmd = "savedAll", saved, failed });
        }

        /// <summary>開いていないファイルに内容を書き出す。BOM の有無・改行の種類は、今のファイルの内容に合わせる
        /// （改行は CRLF が1つでもあれば CRLF。LoadFile と同じ判定）。貼り付けた画像は「&lt;ファイル名&gt;.images」へ移す。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        /// <param name="a_markdown">書き出す内容（改行は LF）。</param>
        private void WriteOtherFile(string a_path, string a_markdown)
        {
            bool bom = false;
            bool crlf = true;
            if (File.Exists(a_path))
            {
                byte[] bytes = File.ReadAllBytes(a_path);
                bom = bytes.Length >= 3 && 0xEF == bytes[0] && 0xBB == bytes[1] && 0xBF == bytes[2];
                crlf = new UTF8Encoding(false).GetString(bytes).Contains("\r\n");
            }
            string markdown = RelocateTempImages(a_markdown, a_path, new System.Collections.Generic.Dictionary<string, string>());
            string text = crlf ? markdown.Replace("\r\n", "\n").Replace("\n", "\r\n") : markdown;
            File.WriteAllText(a_path, text, new UTF8Encoding(bom));
        }

        /// <summary>「新規」で開いたウィンドウの位置・サイズを渡す起動時引数の名前。</summary>
        private const string PLACEMENT_OPTION = "--placement=";

        /// <summary>「新規」：このアプリをもう 1 つ起動して、新しいウィンドウを開く。新しいウィンドウは、
        /// 今のウィンドウから少し右下にずらした位置に同じ大きさで開く（今のウィンドウが最大化されていれば最大化）。</summary>
        private void OpenNewWindow()
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath) { UseShellExecute = false };
                string placement = PlacementForNewWindow();
                if (null != placement)
                {
                    psi.ArgumentList.Add(PLACEMENT_OPTION + placement);
                }
                System.Diagnostics.Process.Start(psi);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("新しいウィンドウを開けませんでした", ex);
                Post(new { cmd = "error", message = $"新しいウィンドウを開けませんでした。\n{ex.Message}" });
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int dwFlags);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(POINT pt, int dwFlags);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
        private const int MONITOR_DEFAULTTONEAREST = 2;
        private const int MONITOR_DEFAULTTOPRIMARY = 1;

        /// <summary>新しいウィンドウの位置・サイズ（"左,上,右,下,最大化なら1"）。今のウィンドウ（最大化・スナップ
        /// している場合はその前の位置）から右下にずらす。画面の作業領域（タスクバーを除いた部分）から
        /// はみ出す場合は、作業領域の左上に置く。</summary>
        /// <returns>--placement= に渡す値。今のウィンドウの位置を得られなかった場合は null（新しいウィンドウは前回の位置で開く）。</returns>
        private string PlacementForNewWindow()
        {
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf<WINDOWPLACEMENT>() };
            if (IntPtr.Zero == hwnd || !GetWindowPlacement(hwnd, ref wp))
            {
                return null;
            }
            RECT r = wp.rcNormalPosition;
            int width = r.Right - r.Left;
            int height = r.Bottom - r.Top;
            int offset = (int)Math.Round(32 * System.Windows.Media.VisualTreeHelper.GetDpi(this).DpiScaleX);
            int left = r.Left + offset;
            int top = r.Top + offset;
            var monitor = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            var primary = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (GetMonitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), ref monitor) &&
                GetMonitorInfo(MonitorFromPoint(new POINT(), MONITOR_DEFAULTTOPRIMARY), ref primary))
            {
                // rcNormalPosition は「ワークスペース座標」（メインのモニターの作業領域の左上が原点）なので、
                // 作業領域もその座標に合わせて比べる
                int workLeft = monitor.rcWork.Left - primary.rcWork.Left;
                int workTop = monitor.rcWork.Top - primary.rcWork.Top;
                int workRight = monitor.rcWork.Right - primary.rcWork.Left;
                int workBottom = monitor.rcWork.Bottom - primary.rcWork.Top;
                if (left + width > workRight || top + height > workBottom)
                {
                    left = workLeft;
                    top = workTop;
                }
            }
            bool maximized = SW_SHOWMAXIMIZED == wp.showCmd;
            return $"{left},{top},{left + width},{top + height},{(maximized ? 1 : 0)}";
        }

        /// <summary>起動時引数 --placement= の値を読む（OpenNewWindow 参照）。</summary>
        /// <param name="a_value">"左,上,右,下,最大化なら1" の形の値（無ければ null）。</param>
        /// <param name="a_maximized">最大化して開くかを受け取る。</param>
        /// <returns>ウィンドウの位置・サイズ。値が無い・不正な場合は null。</returns>
        private static WindowBounds ParsePlacement(string a_value, out bool a_maximized)
        {
            a_maximized = false;
            if (string.IsNullOrEmpty(a_value))
            {
                return null;
            }
            string[] parts = a_value.Split(',');
            if (5 != parts.Length)
            {
                return null;
            }
            var values = new int[5];
            for (int i = 0; i < 5; i++)
            {
                if (!int.TryParse(parts[i], out values[i]))
                {
                    return null;
                }
            }
            a_maximized = 1 == values[4];
            return new WindowBounds { Left = values[0], Top = values[1], Right = values[2], Bottom = values[3] };
        }

        /// <summary>起動時引数のパスを絶対パスにする。ファイルの関連付けからのダブルクリック起動、
        /// 「プログラムから開く」、exe へのドラッグ＆ドロップ、コマンドプロンプトからの起動などで
        /// 渡される。相対パスはこの時点の作業フォルダ基準で解決しておく（後でファイルを開く・保存する
        /// ダイアログを使うと作業フォルダが変わり、相対パスのままでは別の場所を指してしまうため）。</summary>
        /// <param name="a_arg">起動時引数のパス（無ければ null）。前後の " は取り除く。</param>
        /// <returns>絶対パス。引数が無ければ null、パスとして不正ならそのままの値。</returns>
        private static string ResolveStartupPath(string a_arg)
        {
            if (string.IsNullOrWhiteSpace(a_arg))
            {
                return null;
            }
            try
            {
                return Path.GetFullPath(a_arg.Trim().Trim('"'));
            }
            catch (Exception)
            {
                return a_arg; // 不正なパス。OpenStartupPath で「見つからない」と表示される
            }
        }

        /// <summary>HTML 側の準備ができた時点で、起動時引数のファイルを開く。開くのは最初の 1 回だけ
        /// （画面の再読み込み等で ready が再送されても、編集中の内容を起動時のファイルで上書きしない）。</summary>
        private void OpenStartupPath()
        {
            string path = m_startupPath;
            m_startupPath = null;
            if (string.IsNullOrEmpty(path))
            {
                return;
            }
            if (File.Exists(path))
            {
                LoadFile(path);
            }
            else if (Directory.Exists(path))
            {
                // フォルダを指定して起動した場合は、フォルダビューに読み込んで、直下の最初のファイルを開く（mde と同じ）
                OpenFolderPath(path, null);
            }
            else
            {
                MessageBox.Show(this, $"起動時に指定されたファイルが見つかりません。\n{path}",
                    Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        /// <summary>リンク先の URL を、既定のブラウザ・メールソフトで開く。誤ってプログラム等を実行しないよう、
        /// http・https・mailto だけを受け付ける。</summary>
        /// <param name="a_url">リンク先の URL。</param>
        private void OpenUrl(string a_url)
        {
            if (!Uri.TryCreate(a_url, UriKind.Absolute, out Uri uri) ||
                ("http" != uri.Scheme && "https" != uri.Scheme && "mailto" != uri.Scheme))
            {
                Post(new { cmd = "error", message = $"このリンクは開けません。\n{a_url}" });
                return;
            }
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Post(new { cmd = "error", message = $"リンク先を開けませんでした。\n{a_url}\n{ex.Message}" });
            }
        }

        /// <summary>相対パスで書かれた Markdown ファイルへのリンクを、開いているファイルのフォルダ基準で解決して、
        /// このウィンドウで開く。</summary>
        /// <param name="a_relativePath">リンクに書かれた相対パス（# より後ろは除いたもの）。</param>
        private void OpenRelativeFile(string a_relativePath)
        {
            if (string.IsNullOrEmpty(m_currentPath))
            {
                Post(new { cmd = "error", message = "保存していない文書では、相対パスのリンクは開けません。" });
                return;
            }
            string full;
            try
            {
                full = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(m_currentPath), a_relativePath.Replace('/', Path.DirectorySeparatorChar)));
            }
            catch (Exception)
            {
                full = null;
            }
            if (null == full || !File.Exists(full))
            {
                Post(new { cmd = "error", message = $"リンク先のファイルが見つかりません。\n{a_relativePath}" });
                return;
            }
            LoadFile(full);
        }

        /// <summary>ファイルを読み込んで HTML 側に表示させる（load を送る）。BOM の有無・改行の種類は保存時のために覚えておく。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        private void LoadFile(string a_path)
        {
            try
            {
                byte[] bytes = File.ReadAllBytes(a_path);
                // UTF-8 の BOM の有無を覚えておき、保存時も同じにする（BOM 付きのまま Markdown 解析に
                // 渡すと位置がずれて太字等が壊れるため、BOM は取り除いてから HTML 側へ渡す）。
                m_hasBom = bytes.Length >= 3 && 0xEF == bytes[0] && 0xBB == bytes[1] && 0xBF == bytes[2];
                string text = new UTF8Encoding(false).GetString(bytes, m_hasBom ? 3 : 0, bytes.Length - (m_hasBom ? 3 : 0));
                m_useCrLf = text.Contains("\r\n");
                m_currentPath = a_path;
                string docBase = SetDocumentFolder(a_path);
                Post(new { cmd = "load", path = a_path, name = Path.GetFileName(a_path), docBase, markdown = text.Replace("\r\n", "\n") });
            }
            catch (Exception ex)
            {
                Post(new { cmd = "error", message = $"ファイルを開けませんでした。\n{ex.Message}" });
            }
        }

        /// <summary>ファイルに保存し、HTML 側に saved を送る。新規の文書・名前を付けて保存の場合は、保存先を選ぶ
        /// ダイアログを出す（キャンセルされたら何もしない）。画像は保存先に合わせてコピーし、参照先を書き換える。</summary>
        /// <param name="a_markdown">保存する内容（改行は LF。保存時に読み込んだファイルの改行に合わせる）。</param>
        /// <param name="a_saveAs">名前を付けて保存か。</param>
        /// <param name="a_images">文書内の画像の参照先（HTML 側の collectImageSources が集めたもの）。</param>
        private void SaveFile(string a_markdown, bool a_saveAs, System.Collections.Generic.IReadOnlyList<string> a_images)
        {
            if (!SaveFile(a_markdown, a_saveAs, a_images, out string error) && null != error)
            {
                Post(new { cmd = "error", message = $"保存できませんでした。\n{error}" });
            }
        }

        /// <summary>ファイルに保存し、HTML 側に saved を送る（SaveFile と同じ。失敗しても error は送らず、理由を返す）。</summary>
        /// <param name="a_markdown">保存する内容（改行は LF）。</param>
        /// <param name="a_saveAs">名前を付けて保存か。</param>
        /// <param name="a_images">文書内の画像の参照先。</param>
        /// <param name="a_error">失敗した理由を受け取る（保存先を選ぶダイアログでキャンセルされた場合は null）。</param>
        /// <returns>保存できたら true。</returns>
        private bool SaveFile(string a_markdown, bool a_saveAs, System.Collections.Generic.IReadOnlyList<string> a_images, out string a_error)
        {
            a_error = null;
            string oldPath = m_currentPath;
            string path = m_currentPath;
            if (a_saveAs || string.IsNullOrEmpty(path))
            {
                var sfd = new SaveFileDialog
                {
                    Filter = "Markdown ファイル (*.md)|*.md|すべてのファイル (*.*)|*.*",
                    FileName = string.IsNullOrEmpty(path) ? "無題.md" : Path.GetFileName(path),
                };
                if (true != sfd.ShowDialog(this))
                {
                    return false;
                }
                path = sfd.FileName;
            }
            try
            {
                // 貼り付けた画像（一時フォルダ）を保存先の「<ファイル名>.images」へ移し、URL を書き換える
                var replacements = new System.Collections.Generic.Dictionary<string, string>();
                // 「名前を付けて保存」で保存先のフォルダやファイル名が変わる場合は、相対パスの画像も新しい保存先へコピーする
                string markdown = RelocateRelativeImages(a_markdown, oldPath, path, a_images, replacements);
                markdown = RelocateTempImages(markdown, path, replacements);
                string text = m_useCrLf ? markdown.Replace("\r\n", "\n").Replace("\n", "\r\n") : markdown;
                File.WriteAllText(path, text, new UTF8Encoding(m_hasBom));
                m_currentPath = path;
                string docBase = SetDocumentFolder(path);
                Post(new { cmd = "saved", path, name = Path.GetFileName(path), docBase, markdown, replacements });
                return true;
            }
            catch (Exception ex)
            {
                a_error = ex.Message;
                return false;
            }
        }

        /// <summary>開いているファイルのフォルダを、画像の読み込み元として設定する。
        /// 戻り値は HTML 側で &lt;base href&gt; に使う URL。ファイルを開き直すたびに世代番号を変えて、
        /// 別フォルダの同名画像がブラウザのキャッシュから表示されないようにする。</summary>
        /// <param name="a_path">開いた・保存したファイルのパス。</param>
        /// <returns>https://doc.mdew/&lt;世代&gt;/ の形の URL。</returns>
        private string SetDocumentFolder(string a_path)
        {
            m_docFolder = Path.GetDirectoryName(Path.GetFullPath(a_path));
            m_docGeneration++;
            return $"https://{DOC_HOST}/{m_docGeneration}/";
        }

        // ===== クリップボードの画像の貼り付け（web\js\editor.js の onPaste、web\js\main.js 参照） =====

        /// <summary>貼り付けられた画像を一時フォルダに「clipboard_image_連番.拡張子」で保存し、
        /// 表示用の仮の URL を HTML 側へ返す（imagePasted を送る）。</summary>
        /// <param name="a_id">HTML 側が付けた画像の番号（imagePasted でそのまま返す）。</param>
        /// <param name="a_mimeType">画像の種類（image/png 等。拡張子を決めるのに使う）。</param>
        /// <param name="a_base64">画像のデータ（Base64）。</param>
        private void SavePastedImage(int a_id, string a_mimeType, string a_base64)
        {
            try
            {
                string ext = a_mimeType switch
                {
                    "image/jpeg" => ".jpg",
                    "image/gif" => ".gif",
                    "image/bmp" => ".bmp",
                    "image/webp" => ".webp",
                    _ => ".png",
                };
                Directory.CreateDirectory(m_tempImageDir);
                string fileName = GenerateSequentialFileName(m_tempImageDir, PASTED_IMAGE_BASE_NAME, ext);
                File.WriteAllBytes(Path.Combine(m_tempImageDir, fileName), Convert.FromBase64String(a_base64));
                Post(new
                {
                    cmd = "imagePasted",
                    id = a_id,
                    url = $"https://{TMP_HOST}/{Uri.EscapeDataString(fileName)}",
                    alt = Path.GetFileNameWithoutExtension(fileName),
                });
            }
            catch (Exception ex)
            {
                Post(new { cmd = "error", message = $"クリップボードの画像を貼り付けられませんでした。\n{ex.Message}" });
            }
        }

        /// <summary>保存する Markdown の中の、貼り付けた画像の仮の URL（https://tmp.mdew/...）について、
        /// 画像を保存先の隣の「&lt;ファイル名&gt;.images」フォルダへコピーし、URL をそのフォルダへの
        /// 相対パスに書き換える。フォルダに同名のファイルがあれば連番を付けて重複を避ける。
        /// 一時フォルダの画像は、保存後に「元に戻す」で仮の URL に戻った場合に備えて、ウィンドウを
        /// 閉じるまで残しておく。</summary>
        /// <param name="a_markdown">保存する内容。</param>
        /// <param name="a_savePath">保存先のファイルのパス。</param>
        /// <param name="a_replacements">書き換えた URL の対応（仮の URL → 相対パス）を受け取る。</param>
        /// <returns>URL を書き換えた内容（貼り付けた画像が無ければ a_markdown のまま）。</returns>
        private string RelocateTempImages(string a_markdown, string a_savePath,
            System.Collections.Generic.Dictionary<string, string> a_replacements)
        {
            string prefix = $"https://{TMP_HOST}/";
            if (!a_markdown.Contains(prefix))
            {
                return a_markdown;
            }
            // 文中の仮の URL ごとに、一時フォルダの画像を「<ファイル名>.images」へコピーして参照先を書き換える
            string folderName = Path.GetFileNameWithoutExtension(a_savePath) + ".images";
            string destDir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(a_savePath)), folderName);
            var urls = System.Text.RegularExpressions.Regex.Matches(a_markdown, @"https://tmp\.mdew/[^\s)>""']+");
            string result = a_markdown;
            foreach (System.Text.RegularExpressions.Match m in urls)
            {
                string url = m.Value;
                if (a_replacements.ContainsKey(url))
                {
                    continue;
                }
                string src = Path.Combine(m_tempImageDir, Path.GetFileName(Uri.UnescapeDataString(url.Substring(prefix.Length))));
                if (!File.Exists(src))
                {
                    continue;
                }
                Directory.CreateDirectory(destDir);
                string ext = Path.GetExtension(src);
                string fileName = Path.GetFileName(src);
                if (File.Exists(Path.Combine(destDir, fileName)))
                {
                    fileName = GenerateSequentialFileName(destDir, Path.GetFileNameWithoutExtension(src), ext);
                }
                File.Copy(src, Path.Combine(destDir, fileName));
                string rel = folderName + "/" + fileName;
                a_replacements[url] = rel;
                // Markdown の画像記法では、空白や括弧を含むパスは <...> で囲む必要がある
                string dest = rel.IndexOfAny(new[] { ' ', '(', ')' }) >= 0 ? $"<{rel}>" : rel;
                result = result.Replace($"]({url})", $"]({dest})").Replace(url, rel);
            }
            return result;
        }

        /// <summary>
        /// 「名前を付けて保存」で保存先のフォルダやファイル名が変わる場合に、文書内の相対パスの画像を
        /// 新しい保存先から見て同じ相対パスの位置へコピーする（mde の ImageManager.
        /// RelocateImagesFromOldFileImagesFolder と同じ動き）。
        ///  - 変更前のファイル専用の画像フォルダ「&lt;変更前のファイル名&gt;.images」の中の画像は、
        ///    ファイル名も変わる場合、フォルダ名を「&lt;新しいファイル名&gt;.images」に変え、文中のパスも書き換える。
        ///  - それ以外（共有の images フォルダ等）は、フォルダ名を変えずに同じ相対パスの構造でコピーする。
        ///  - コピー先に既にファイルがある場合は上書きしない（直前の保存でコピー済み等）。
        ///  - 変更前のファイルの画像は削除しない（変更前のファイルが引き続き参照しているため）。
        ///  - 絶対パス・http(s)・data: の画像、まだ保存していない画像（一時フォルダ）は対象外。
        /// </summary>
        /// <param name="a_markdown">保存する内容。</param>
        /// <param name="a_oldPath">変更前のファイルのパス（新規の文書は null）。</param>
        /// <param name="a_newPath">保存先のファイルのパス。</param>
        /// <param name="a_images">文書内の画像の参照先（HTML 側の collectImageSources が集めたもの）。</param>
        /// <param name="a_replacements">書き換えたパスの対応（変更前 → 変更後）を受け取る。</param>
        /// <returns>パスを書き換えた内容（書き換えが無ければ a_markdown のまま）。</returns>
        private static string RelocateRelativeImages(string a_markdown, string a_oldPath, string a_newPath,
            System.Collections.Generic.IReadOnlyList<string> a_images, System.Collections.Generic.Dictionary<string, string> a_replacements)
        {
            if (string.IsNullOrEmpty(a_oldPath) || null == a_images || 0 == a_images.Count)
            {
                return a_markdown;
            }
            string oldDir = Path.GetDirectoryName(Path.GetFullPath(a_oldPath));
            string newDir = Path.GetDirectoryName(Path.GetFullPath(a_newPath));
            bool sameFolder = string.Equals(oldDir, newDir, StringComparison.OrdinalIgnoreCase);
            string oldOwnedFolder = Path.GetFileNameWithoutExtension(a_oldPath) + ".images";
            string newOwnedFolder = Path.GetFileNameWithoutExtension(a_newPath) + ".images";
            bool renameOwnedFolder = !string.Equals(oldOwnedFolder, newOwnedFolder, StringComparison.OrdinalIgnoreCase);
            if (sameFolder && !renameOwnedFolder)
            {
                return a_markdown; // 上書き保存、または同じ名前での保存
            }

            // 画像ごとに、コピー先を決めてコピーし、パスが変わる場合は文中の参照先を書き換える
            string result = a_markdown;
            foreach (string src in a_images)
            {
                if (string.IsNullOrEmpty(src) || src.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                    src.StartsWith("//") || Path.IsPathRooted(src) || Uri.TryCreate(src, UriKind.Absolute, out _))
                {
                    continue; // http(s)・file:・一時フォルダの画像（https://tmp.mdew/）・絶対パスなど
                }
                // パスの後ろの ?xxx や #xxx は除き、%20 などの表記はファイル名に戻す
                string pathPart = src.Split('?', '#')[0];
                string relSrc = pathPart.Replace('/', Path.DirectorySeparatorChar);
                if (!File.Exists(Path.Combine(oldDir, relSrc)))
                {
                    relSrc = Uri.UnescapeDataString(relSrc);
                }

                string destRelSrc = relSrc;
                string firstSegment = relSrc.Split(Path.DirectorySeparatorChar)[0];
                if (renameOwnedFolder && string.Equals(firstSegment, oldOwnedFolder, StringComparison.OrdinalIgnoreCase))
                {
                    destRelSrc = newOwnedFolder + relSrc.Substring(firstSegment.Length);
                }
                bool relSrcChanged = !string.Equals(relSrc, destRelSrc, StringComparison.OrdinalIgnoreCase);
                if (sameFolder && !relSrcChanged)
                {
                    continue; // 同じフォルダで相対パスも変わらないなら、そのまま表示できる
                }

                string fullSrc;
                string fullDest;
                try
                {
                    fullSrc = Path.GetFullPath(Path.Combine(oldDir, relSrc));
                    fullDest = Path.GetFullPath(Path.Combine(newDir, destRelSrc));
                }
                catch (Exception)
                {
                    continue;
                }
                if (string.Equals(fullSrc, fullDest, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (!File.Exists(fullDest))
                {
                    if (!File.Exists(fullSrc))
                    {
                        continue; // 元の画像が見つからない
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(fullDest));
                    File.Copy(fullSrc, fullDest, false);
                }

                if (relSrcChanged)
                {
                    string newSrc = destRelSrc.Replace(Path.DirectorySeparatorChar, '/');
                    a_replacements[src] = newSrc;
                    result = ReplaceImageReference(result, src, newSrc);
                }
            }
            return result;
        }

        /// <summary>Markdown の中の画像の参照先を書き換える。画像記法 ![](参照先)・![](&lt;参照先&gt;)、
        /// HTML の src="参照先"、リンク定義 [x]: 参照先 の形の箇所だけを対象にし、本文中に同じ文字列が
        /// あっても書き換えない。</summary>
        /// <param name="a_markdown">書き換える Markdown。</param>
        /// <param name="a_oldSrc">変更前の参照先。</param>
        /// <param name="a_newSrc">変更後の参照先（空白・括弧を含む場合は画像記法では &lt;&gt; で囲む）。</param>
        /// <returns>書き換えた Markdown。</returns>
        private static string ReplaceImageReference(string a_markdown, string a_oldSrc, string a_newSrc)
        {
            bool needsAngle = a_newSrc.IndexOfAny(new[] { ' ', '(', ')' }) >= 0;
            string dest = needsAngle ? $"<{a_newSrc}>" : a_newSrc;
            string result = a_markdown
                .Replace($"](<{a_oldSrc}>", $"]({dest}")
                .Replace($"]({a_oldSrc})", $"]({dest})")
                .Replace($"]({a_oldSrc} ", $"]({dest} ")
                .Replace($"src=\"{a_oldSrc}\"", $"src=\"{a_newSrc}\"")
                .Replace($"src='{a_oldSrc}'", $"src='{a_newSrc}'");
            // 空白を含むパスは、Markdown では %20 と書かれていることもある
            string encodedOld = a_oldSrc.Replace(" ", "%20");
            if (!string.Equals(encodedOld, a_oldSrc, StringComparison.Ordinal))
            {
                result = result.Replace($"]({encodedOld})", $"]({a_newSrc.Replace(" ", "%20")})")
                    .Replace($"]({encodedOld} ", $"]({a_newSrc.Replace(" ", "%20")} ");
            }
            return System.Text.RegularExpressions.Regex.Replace(result,
                @"^(\s*\[[^\]]+\]:\s*)" + System.Text.RegularExpressions.Regex.Escape(a_oldSrc) + @"(?=\s|$)",
                m => m.Groups[1].Value + dest, System.Text.RegularExpressions.RegexOptions.Multiline);
        }

        /// <summary>フォルダ内で既存ファイルと重ならない「ベース名_連番.拡張子」を作る（連番は 1 から）。</summary>
        /// <param name="a_dir">フォルダ。</param>
        /// <param name="a_baseName">ファイル名の先頭（clipboard_image 等）。</param>
        /// <param name="a_ext">拡張子（「.」を含む）。</param>
        /// <returns>ファイル名（フォルダは含まない）。</returns>
        private static string GenerateSequentialFileName(string a_dir, string a_baseName, string a_ext)
        {
            for (int i = 1; ; i++)
            {
                string name = $"{a_baseName}_{i}{a_ext}";
                if (!File.Exists(Path.Combine(a_dir, name)))
                {
                    return name;
                }
            }
        }

        /// <summary>このウィンドウの一時フォルダを削除する（保存しなかった貼り付け画像の後始末）。</summary>
        private void DeleteTempImages()
        {
            try
            {
                if (Directory.Exists(m_tempImageDir))
                {
                    Directory.Delete(m_tempImageDir, true);
                }
            }
            catch (Exception)
            {
                // 削除できなくても致命的ではない
            }
        }

        /// <summary>画像として返すファイルの拡張子と、その Content-Type。</summary>
        private static readonly System.Collections.Generic.Dictionary<string, string> s_imageTypes =
            new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif",
                [".bmp"] = "image/bmp", [".webp"] = "image/webp", [".svg"] = "image/svg+xml", [".ico"] = "image/x-icon",
            };

        /// <summary>https://doc.mdew/&lt;世代&gt;/&lt;相対パス&gt; の要求に、開いているファイルのフォルダ基準で
        /// 画像ファイルを返す。画像以外・存在しないファイルは 404 にする。
        /// https://tmp.mdew/&lt;ファイル名&gt; の要求には、このウィンドウの一時フォルダの貼り付けた画像を返す。</summary>
        /// <param name="a_sender">CoreWebView2。</param>
        /// <param name="a_args">要求。Response に返す内容を設定する（設定しなければ通常の読み込み）。</param>
        private void ServeDocumentResource(object a_sender, CoreWebView2WebResourceRequestedEventArgs a_args)
        {
            var env = m_webView.CoreWebView2.Environment;
            try
            {
                var uri = new Uri(a_args.Request.Uri);
                string rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                string full = null;
                if (string.Equals(uri.Host, TMP_HOST, StringComparison.OrdinalIgnoreCase))
                {
                    // 貼り付けた画像の一時フォルダ。フォルダの外は参照させない（ファイル名だけを使う）
                    string fileName = Path.GetFileName(rel);
                    full = 0 < fileName.Length ? Path.Combine(m_tempImageDir, fileName) : null;
                }
                else if (!string.Equals(uri.Host, DOC_HOST, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
                int slash = rel.IndexOf('/');
                rel = slash >= 0 ? rel.Substring(slash + 1) : string.Empty; // 先頭の世代番号を除く
                if (null == full && !string.IsNullOrEmpty(m_docFolder) && rel.Length > 0)
                {
                    // ![](C:/dir/a.png) のような絶対パスはそのまま使う（Path.Combine は絶対パスを優先する）
                    full = Path.GetFullPath(Path.Combine(m_docFolder, rel.Replace('/', Path.DirectorySeparatorChar)));
                }
                if (null == full || !File.Exists(full) || !s_imageTypes.TryGetValue(Path.GetExtension(full), out string mime))
                {
                    a_args.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Cache-Control: no-store");
                    return;
                }
                var stream = new MemoryStream(File.ReadAllBytes(full));
                a_args.Response = env.CreateWebResourceResponse(stream, 200, "OK",
                    $"Content-Type: {mime}\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *");
            }
            catch (Exception)
            {
                a_args.Response = env.CreateWebResourceResponse(null, 500, "Error", "Cache-Control: no-store");
            }
        }

        // ===== 検証用：IMEを外部からオンにする（自動テストで日本語入力を行うためだけの機能） =====
        [StructLayout(LayoutKind.Sequential)]
        private struct GUITHREADINFO
        {
            public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
            public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret;
            public int left, top, right, bottom;
        }
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
        [DllImport("imm32.dll")] private static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        /// <summary>WebView2 内（別プロセス）で入力中のウィンドウの IME をオン・ひらがなにする。
        /// ImmGetDefaultIMEWnd で得た IME 用ウィンドウへの WM_IME_CONTROL は、他プロセスの
        /// ウィンドウにも効く。HTML 側の Ctrl+Shift+F12 から呼ばれる。</summary>
        private static void ForceImeOn()
        {
            IntPtr fg = GetForegroundWindow();
            uint tid = GetWindowThreadProcessId(fg, out _);
            var info = new GUITHREADINFO { cbSize = Marshal.SizeOf<GUITHREADINFO>() };
            IntPtr target = GetGUIThreadInfo(tid, ref info) && IntPtr.Zero != info.hwndFocus ? info.hwndFocus : fg;
            IntPtr imeWnd = ImmGetDefaultIMEWnd(target);
            const uint WM_IME_CONTROL = 0x0283;
            SendMessage(imeWnd, WM_IME_CONTROL, (IntPtr)0x0006, (IntPtr)1);   // IMC_SETOPENSTATUS = オン
            SendMessage(imeWnd, WM_IME_CONTROL, (IntPtr)0x0002, (IntPtr)0x9); // IMC_SETCONVERSIONMODE = ひらがな
        }

        /// <summary>ウィンドウを閉じる前に、保存していない変更があれば確認する。閉じる場合は、ウィンドウの位置・
        /// サイズを次回のために保存する。</summary>
        /// <param name="a_sender">このウィンドウ。</param>
        /// <param name="a_args">閉じるのをやめる場合は Cancel を true にする。</param>
        private void OnClosing(object a_sender, CancelEventArgs a_args)
        {
            if (m_isDirty && !m_closeConfirmed)
            {
                var result = MessageBox.Show(this, "保存されていない変更があります。破棄して閉じますか？",
                    Program.AppName, MessageBoxButton.YesNo, MessageBoxImage.Warning);
                if (MessageBoxResult.Yes != result)
                {
                    a_args.Cancel = true;
                    return;
                }
                m_closeConfirmed = true;
            }
            SaveWindowPlacement();
        }

        // ===== ウィンドウの位置・サイズの保存と復元 =====
        // Win32 の GetWindowPlacement / SetWindowPlacement を使う。WPF の Left/Top/Width/Height だけで
        // 復元する方法と比べて、次の点を OS 側がまとめて正しく扱ってくれる。
        //  - 最大化して終了した場合：次回も最大化して起動し、最大化を解除すると最大化する前の
        //    位置・サイズに戻る。最大化はウィンドウがあったモニターの上で行われる（2台目のモニターで
        //    最大化して終了すれば、次回も2台目で最大化される）。
        //  - 画面の端へスナップして終了した場合：スナップする前の位置・サイズで開く。
        //  - 前回のモニターが外されている等で、保存した位置が画面外になる場合：見える位置へ移される。
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        private struct WINDOWPLACEMENT
        {
            public int length; public int flags; public int showCmd;
            public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
        }
        [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
        [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
        private const int SW_SHOWNORMAL = 1;
        private const int SW_SHOWMINIMIZED = 2;
        private const int SW_SHOWMAXIMIZED = 3;
        private const int WPF_RESTORETOMAXIMIZED = 0x0002;

        /// <summary>ウィンドウが作られた直後（表示される前）に、保存しておいた位置・サイズ・
        /// 最大化状態を適用する。</summary>
        private void RestoreWindowPlacement()
        {
            // 「新規」で開いたウィンドウは、開いた元のウィンドウに合わせた位置（OpenNewWindow 参照）
            WindowBounds b = m_startupBounds ?? m_settings.Window;
            bool maximized = null != m_startupBounds ? m_startupMaximized : m_settings.IsMaximized;
            if (null == b || b.Right - b.Left < 200 || b.Bottom - b.Top < 150)
            {
                return; // 未保存、または異常に小さい値
            }
            var wp = new WINDOWPLACEMENT
            {
                length = Marshal.SizeOf<WINDOWPLACEMENT>(),
                // 最小化して終了した場合も含め、最小化状態では起動しない
                showCmd = maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL,
                rcNormalPosition = new RECT { Left = b.Left, Top = b.Top, Right = b.Right, Bottom = b.Bottom },
            };
            SetWindowPlacement(new WindowInteropHelper(this).Handle, ref wp);
        }

        /// <summary>終了時のウィンドウの位置・サイズ・最大化状態を設定ファイルに保存する。</summary>
        private void SaveWindowPlacement()
        {
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            var wp = new WINDOWPLACEMENT { length = Marshal.SizeOf<WINDOWPLACEMENT>() };
            if (IntPtr.Zero == hwnd || !GetWindowPlacement(hwnd, ref wp))
            {
                return;
            }
            // 画面の端へドラッグして半分の幅にした（スナップした）状態で終了した場合も、rcNormalPosition は
            // スナップする前の位置・サイズなので、次回はスナップ前の状態で開く。
            RECT r = wp.rcNormalPosition;
            m_settings.Window = new WindowBounds { Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Bottom };
            m_settings.IsMaximized = SW_SHOWMAXIMIZED == wp.showCmd ||
                (SW_SHOWMINIMIZED == wp.showCmd && 0 != (wp.flags & WPF_RESTORETOMAXIMIZED));
            m_settings.Save();
        }
    }

    /// <summary>エラー・起動・終了の記録。%LOCALAPPDATA%\&lt;アセンブリ名&gt;\error.log に追記する（1MB を超えたら作り直す）。
    /// 「起動」の次に「終了」が無い記録は、そのとき異常終了（強制終了を含む）したことを表す。</summary>
    public static class ErrorLog
    {
        /// <summary>記録するファイルのパス。</summary>
        public static readonly string FilePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "error.log");

        /// <summary>1 件記録する（日時・プロセス番号・内容）。記録できなくても例外は出さない。</summary>
        /// <param name="a_message">内容。</param>
        /// <param name="a_exception">エラーの詳細（無ければ null）。スタックトレースも記録する。</param>
        public static void Write(string a_message, Exception a_exception)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 1024 * 1024)
                {
                    File.Delete(FilePath);
                }
                string text = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {a_message}";
                if (null != a_exception)
                {
                    text += Environment.NewLine + a_exception;
                }
                File.AppendAllText(FilePath, text + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // 記録できなくても動作には影響させない
            }
        }
    }

    /// <summary>アプリの入口。</summary>
    public static class Program
    {
        /// <summary>アセンブリ名（mdew.csproj の AssemblyName。exe のファイル名）。設定・ログ・WebView2 のデータを置く
        /// %LOCALAPPDATA% の下のフォルダ名や、一時フォルダの名前に使う。</summary>
        public static readonly string AssemblyName = typeof(Program).Assembly.GetName().Name;

        /// <summary>アプリ名（mdew.csproj の AssemblyTitle。mdew）。タイトルバー・メッセージボックス等に表示する。</summary>
        public static readonly string AppName =
            typeof(Program).Assembly.GetCustomAttribute<AssemblyTitleAttribute>()?.Title ?? "mdew";

        /// <summary>アプリのバージョン（mdew.csproj の Version から作られるアセンブリのバージョン。例：0.0.1.0）。
        /// タイトルバー・エラーログに表示する。バージョン情報（dialog\AboutWindow）と同じ表記にしている。</summary>
        public static readonly string Version = typeof(Program).Assembly.GetName().Version?.ToString() ?? string.Empty;

        /// <summary>Debug ビルドか（Visual Studio の構成が Debug）。ステータスバーの停止・入力遅延の回数の表示に使う。</summary>
#if DEBUG
        public const bool IsDebugBuild = true;
#else
        public const bool IsDebugBuild = false;
#endif

        /// <summary>アプリを起動する。想定外のエラーを記録する設定をしてから、ウィンドウを 1 つ開く。</summary>
        /// <param name="a_args">起動時引数。開くファイルのパス（省略可）と、「新規」で開いた時の --placement=。</param>
        [STAThread]
        public static void Main(string[] a_args)
        {
            var app = new Application();
            // 想定外のエラーでアプリが落ちた時に原因を追えるよう、エラーの内容を記録する（ErrorLog 参照）
            app.DispatcherUnhandledException += (s, e) =>
            {
                ErrorLog.Write("画面の処理中の想定外のエラー", e.Exception);
                MessageBox.Show($"予期しないエラーが発生しました。\n\n{e.Exception.Message}\n\n詳細は {ErrorLog.FilePath} に記録しました。",
                    "エラー", MessageBoxButton.OK, MessageBoxImage.Error);
                e.Handled = true;
            };
            AppDomain.CurrentDomain.UnhandledException += (s, e) => ErrorLog.Write("想定外のエラー（アプリ終了）", e.ExceptionObject as Exception);
            System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (s, e) => ErrorLog.Write("非同期処理の想定外のエラー", e.Exception);
            ErrorLog.Write($"起動（v{Version}）", null);
            app.Exit += (s, e) => ErrorLog.Write($"終了（終了コード={e.ApplicationExitCode}）", null);
            // 起動時引数：開くファイルのパスと、「新規」で開いた時のウィンドウの位置（--placement=）
            string path = null;
            string placement = null;
            foreach (string arg in a_args)
            {
                if (arg.StartsWith("--placement=", StringComparison.Ordinal))
                {
                    placement = arg.Substring("--placement=".Length);
                }
                else if (null == path)
                {
                    path = arg;
                }
            }
            app.Run(new MainWindow(path, placement));
        }
    }
}
