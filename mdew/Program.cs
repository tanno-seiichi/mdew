using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.IO;
using System.Reflection;
using System.Runtime;
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
        /// <summary>メニューバーのメニュー（ShowWebMenu）を開く時に、キーボードの入力先を WebView2 から一時的に移すための、
        /// 見えない要素（WebView2 がキーボードの入力先のままだと、矢印キー等がメニューに届かない）。</summary>
        private readonly System.Windows.Controls.Border m_focusSink = new System.Windows.Controls.Border { Focusable = true, Width = 0, Height = 0 };
        /// <summary>開いているファイルのパス。新規（未保存）は null。</summary>
        private string m_currentPath;
        /// <summary>保存していない変更があるか（HTML 側から dirty で知らされる）。</summary>
        private bool m_isDirty;
        /// <summary>保存時の改行を CRLF にするか（読み込んだファイルに合わせる。新規は CRLF）。</summary>
        private bool m_useCrLf = true;
        /// <summary>保存時に UTF-8 の BOM を付けるか（読み込んだファイルに合わせる。新規は付けない）。</summary>
        private bool m_hasBom;
        /// <summary>閉じる時の確認が済んだか（「いいえ」（保存しない）と答えた・保存し終えた。確認を 2 回出さないため）。</summary>
        private bool m_closeConfirmed;
        /// <summary>閉じる時の確認のため、HTML 側に保存していない内容を問い合わせているところか（ConfirmClose 参照）。</summary>
        private bool m_closeQueryPending;
        /// <summary>HTML 側から返事が無い時に、保存できない旨の確認を出すためのタイマー（ConfirmClose 参照）。</summary>
        private System.Windows.Threading.DispatcherTimer m_closeQueryTimer;
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
        /// <summary>WebView2 の環境（裏で動く Edge のプロセス）を作る処理。起動を速くするため、ウィンドウを作る時に
        /// 始めておき、ウィンドウの表示と並行して進める（InitializeWebViewAsync で終わるのを待つ）。</summary>
        private readonly System.Threading.Tasks.Task<CoreWebView2Environment> m_webViewEnvironment;
        /// <summary>起動時引数のファイルを開いて、画面に表示されるのを待っているところか（起動時間の記録用。StartupTiming 参照）。</summary>
        private bool m_startupLoadPending;
        /// <summary>このウィンドウ専用の、貼り付けた画像の一時フォルダ（閉じる時に削除する）。</summary>
        private readonly string m_tempImageDir = Path.Combine(Path.GetTempPath(), Program.AssemblyName, Guid.NewGuid().ToString("N"));

        /// <summary>ウィンドウを作る。WebView2 の準備は、ウィンドウが表示された後（Loaded）に行う。</summary>
        /// <param name="a_startupPath">起動時引数で指定されたファイルのパス（無ければ null）。</param>
        /// <param name="a_placement">起動時引数 --placement= の値（「新規」で開いた時だけ。無ければ null）。</param>
        public MainWindow(string a_startupPath, string a_placement)
        {
            // WebView2 の環境を作り始める（時間がかかるので、ウィンドウの作成・表示と並行して進める）
            m_webViewEnvironment = CreateWebViewEnvironmentAsync();
            ContentRendered += (s, e) => { StartupTiming.Mark("ウィンドウ表示"); };
            // 起動直後に、ウィンドウの中が一瞬白く見えないようにする：ウィンドウを開いた直後は、WPF が最初の描画を終えるまで
            // 中身が白いまま表示される（ダークテーマの時に目立つ）。そこで、最初の描画が終わるまでウィンドウを隠しておく
            // （DWM のクローク。ウィンドウとしては表示されたままで、画面に映らないだけ）
            SourceInitialized += (s, e) => SetCloak(true);
            ContentRendered += (s, e) => SetCloak(false);
            m_startupPath = ResolveStartupPath(a_startupPath);
            m_startupBounds = ParsePlacement(a_placement, out m_startupMaximized);
            Title = $"{Program.AppName} v{Program.Version}";
            // 初めて起動した時のウィンドウの大きさ（mde と同じ。2回目からは前回終了時の大きさ）
            Width = 810;
            Height = 670;
            var root = new System.Windows.Controls.Grid();
            root.Children.Add(m_webView);
            root.Children.Add(m_focusSink);
            Content = root;
            Loaded += async (s, e) => await InitializeWebViewAsync();
            Closing += OnClosing;
            // ほかのウィンドウで開いた・保存したファイルも、最近使ったファイルに出るよう、手前に来るたびに読み直す
            Activated += (s, e) =>
            {
                if (null != m_webView.CoreWebView2)
                {
                    AppSettings latest = AppSettings.Load();
                    PostRecentFiles(latest);
                    // ほかのウィンドウ（別のプロセス）でテーマを変えた時も合わせる
                    if (Theme.Normalize(latest.Theme) != Theme.Mode)
                    {
                        Theme.SetMode(latest.Theme);
                    }
                }
                // キーボードの入力先を WebView2 に戻す。バージョン情報等のダイアログを閉じた後、入力先が WebView2 に戻らず、
                // Alt+F 等のメニューのショートカットやメニューの外の文字入力が効かないことがあるため（メニューを開いている間は除く）
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    if (IsActive && null == m_webMenu)
                    {
                        m_webView.Focus();
                    }
                }), System.Windows.Threading.DispatcherPriority.Input);
            };
            // 前回終了時のウィンドウの位置・サイズ・最大化状態を復元する（RestoreWindowPlacement 参照）。
            // 初回起動時（まだ保存されていない時）は画面の中央に表示する。
            if (null == m_settings.Window && null == m_startupBounds)
            {
                WindowStartupLocation = WindowStartupLocation.CenterScreen;
            }
            SourceInitialized += (s, e) => RestoreWindowPlacement();
            Closed += (s, e) => DeleteTempImages();
            // 配色（ライト・ダーク。Theme.cs）：タイトルバーは表示する前に合わせる（ウィンドウが作られた時）。
            // メニュー「表示」→「テーマ」・Windows の設定で変わった時も合わせ直す
            SourceInitialized += (s, e) => Theme.Apply(this);
            ApplyThemeBackground();
            Theme.Changed += OnThemeChanged;
            Closed += (s, e) => Theme.Changed -= OnThemeChanged;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr a_window, int a_attribute, ref int a_value, int a_size);

        /// <summary>DwmSetWindowAttribute の DWMWA_CLOAK（ウィンドウを画面に映さない）。</summary>
        private const int DWMWA_CLOAK = 13;

        /// <summary>ウィンドウを画面に映さない・映す（DWM のクローク。起動直後の白い画面を見せないため。コンストラクター参照）。
        /// 使えない環境では何もしない（白い画面が一瞬見えるだけ）。</summary>
        /// <param name="a_cloak">映さないなら true。</param>
        private void SetCloak(bool a_cloak)
        {
            IntPtr handle = new WindowInteropHelper(this).Handle;
            if (IntPtr.Zero == handle)
            {
                return;
            }
            int value = a_cloak ? 1 : 0;
            DwmSetWindowAttribute(handle, DWMWA_CLOAK, ref value, sizeof(int));
        }

        /// <summary>WebView2 の環境を作る（裏で Edge のプロセスが起動する）。WebView2 の作業用のデータ（キャッシュ・
        /// localStorage 等）は %LOCALAPPDATA%\&lt;アセンブリ名&gt;\WebView2 に置く。</summary>
        /// <returns>作った環境。</returns>
        private static async System.Threading.Tasks.Task<CoreWebView2Environment> CreateWebViewEnvironmentAsync()
        {
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "WebView2");
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
            StartupTiming.Mark("WebView2の環境");
            return env;
        }

        /// <summary>WebView2 を準備して画面（web\index.html）を表示する。ブラウザのキャッシュの削除、
        /// 仮想ホスト名の設定、HTML 側とのメッセージ・画像の要求・クリップボードの許可の受け付けを行う。</summary>
        /// <returns>準備が終わるまでの非同期処理。</returns>
        private async System.Threading.Tasks.Task InitializeWebViewAsync()
        {
            // 環境は、ウィンドウを作った時に作り始めている（CreateWebViewEnvironmentAsync）
            var env = await m_webViewEnvironment;
            await m_webView.EnsureCoreWebView2Async(env);
            StartupTiming.Mark("WebView2の準備");
            var core = m_webView.CoreWebView2;

            // 画面側（web フォルダ）のファイルを更新した時に、前回読み込んだ古いファイルがブラウザの
            // キャッシュから使われてしまわないよう、キャッシュを消す。消すのは、web フォルダのファイル・mdew.dll が
            // 前回消した時から変わった時だけ（起動のたびに消すと、その分起動が遅くなるため。WebCacheStamp 参照）
            string webDir = Path.Combine(AppContext.BaseDirectory, "web");
            string stamp = WebCacheStamp.Create(webDir);
            if (WebCacheStamp.IsChanged(stamp))
            {
                await core.Profile.ClearBrowsingDataAsync(
                    CoreWebView2BrowsingDataKinds.DiskCache | CoreWebView2BrowsingDataKinds.CacheStorage);
                WebCacheStamp.Save(stamp);
                StartupTiming.Mark("キャッシュ削除");
            }

            // Ctrl+R での再読み込み等で編集中の内容が消えないよう、ブラウザ用のショートカットは無効にする。
            // （F12・Ctrl+Shift+I の開発者ツールも無効になるため、F12 は HTML 側から devTools で開く）
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // Ctrl+マウスホイールで画面全体（メニュー等も）が拡大されないようにする。文書の表示倍率は HTML 側で変える
            // （web\js\main.js の setZoom）
            core.Settings.IsZoomControlEnabled = false;

            core.SetVirtualHostNameToFolderMapping(APP_HOST, webDir, CoreWebView2HostResourceAccessKind.Allow);
            // 文書内の画像（相対パス）は https://doc.mdew/<世代>/<相対パス> として要求されるので、
            // 開いているファイルのフォルダから読んで返す（ServeDocumentResource 参照）。
            core.AddWebResourceRequestedFilter($"https://{DOC_HOST}/*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter($"https://{TMP_HOST}/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeDocumentResource;
            // タイトルバー：HTML 側のタイトル（「* ファイル名」）の後ろに、アプリ名とバージョンを付ける
            core.DocumentTitleChanged += (s, e) =>
            {
                Title = $"{core.DocumentTitle} - {Program.AppName} v{Program.Version}";
                // 起動時引数のファイルを表示し終えた（画面側は、文書を表示した後にタイトルを変える。main.js の load）
                if (m_startupLoadPending)
                {
                    m_startupLoadPending = false;
                    StartupTiming.Finish("ファイル表示");
                }
            };
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
            // 最初の配色（画面側の main.js が、読み込んですぐに合わせる。画面が一瞬白く表示されないように）
            await core.AddScriptToExecuteOnDocumentCreatedAsync($"window.__mdewTheme = {JsonSerializer.Serialize(Theme.CreateMessage())};");
            core.Navigate($"https://{APP_HOST}/index.html");
        }

        /// <summary>配色（Theme.cs）が変わった時：背景と、画面側の配色を合わせ直す。</summary>
        private void OnThemeChanged()
        {
            ApplyThemeBackground();
            if (null != m_webView.CoreWebView2)
            {
                Post(Theme.CreateMessage());
            }
        }

        /// <summary>画面を表示する前・読み込み中に見える背景（ウィンドウと WebView2）を、今の配色に合わせる。</summary>
        private void ApplyThemeBackground()
        {
            System.Drawing.Color color = Theme.WebBackground;
            m_webView.DefaultBackgroundColor = color;
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(color.R, color.G, color.B));
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
                    StartupTiming.Mark("画面の準備");
                    // 配色（ライト・ダーク。Theme.cs）
                    Post(Theme.CreateMessage());
                    // 画面側の設定（Debug ビルドの時は、ステータスバーに停止・入力遅延の回数を表示する）
                    // 貼り付けた画像の一時フォルダ（他のアプリへコピーする時に、画像のファイルの場所にする）
                    Post(new { cmd = "init", debug = Program.IsDebugBuild, tempDir = m_tempImageDir });
                    PostRecentFiles(AppSettings.Load());
                    OpenStartupPath();
                    if (!m_startupLoadPending)
                    {
                        // 開くファイルが無い（または開けなかった）時は、ここまでを起動時間として記録する
                        StartupTiming.Finish("ファイル無し");
                    }
                    // すぐに書き始められるよう、編集領域にキーボードの入力先を移す
                    m_webView.Focus();
                    Post(new { cmd = "focus" });
                    break;
                case "setTheme":
                    // メニュー「表示」→「テーマ」：選び方を保存して、すべてのウィンドウ・画面側に反映する（OnThemeChanged）
                    {
                        string mode = Theme.Normalize(root.GetProperty("mode").GetString());
                        AppSettings themeSettings = AppSettings.Load();
                        themeSettings.Theme = mode;
                        themeSettings.Save();
                        Theme.SetMode(mode);
                    }
                    break;
                case "open":
                    var ofd = new OpenFileDialog
                    {
                        Filter = "Markdown ファイル (*.md;*.markdown)|*.md;*.markdown|すべてのファイル (*.*)|*.*",
                    };
                    if (true == ofd.ShowDialog(this))
                    {
                        // newWindow：このウィンドウでフォルダ・ファイルを開いている時は、新しいウィンドウで開く（main.js の opensInNewWindow）。
                        // ただし、このウィンドウで開いているファイルそのものを選んだ時は、このウィンドウで開き直す（同じファイルを2つの
                        // ウィンドウで開かないように）
                        if (IsNewWindowRequested(root) && !string.Equals(ofd.FileName, m_currentPath, StringComparison.OrdinalIgnoreCase))
                        {
                            OpenNewWindow(ofd.FileName);
                        }
                        else
                        {
                            LoadFile(ofd.FileName);
                        }
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
                        ? relElement.GetString() : null, IsNewWindowRequested(root));
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
                case "confirmClose":
                    ConfirmClose(root.GetProperty("files"));
                    break;
                case "openFind":
                    ShowFindWindow(root.TryGetProperty("text", out JsonElement findText) && JsonValueKind.String == findText.ValueKind
                        ? findText.GetString() : null);
                    break;
                case "findUpdate":
                    m_findWindow?.ApplyUpdate(root);
                    break;
                case "openImage":
                    OpenImage(root.GetProperty("src").GetString());
                    break;
                case "exportPdf":
                    _ = ExportPdfAsync(root.GetProperty("name").GetString());
                    break;
                case "pdfMargin":
                    ShowPdfMarginDialog();
                    break;
                case "showMenu":
                    // メニューバーのメニュー（WPF のメニューで開く。見た目は HTML のメニューとそろえる）
                    ShowWebMenu(root);
                    break;
                case "tableSizeDialog":
                    // 右クリックのメニュー「表を挿入…」
                    ShowTableSizeDialog();
                    break;
                case "linkDialog":
                    // 右クリックのメニュー「リンクにする…」
                    ShowLinkDialog();
                    break;
                case "copyHtml":
                    CopyHtml(root.GetProperty("html").GetString(), root.GetProperty("text").GetString());
                    break;
                case "importImages":
                    ImportImages(root.GetProperty("id").GetInt32(), root.GetProperty("srcs"));
                    break;
                case "openRecent":
                    OpenRecentFile(root.GetProperty("path").GetString(), IsNewWindowRequested(root));
                    break;
                case "clearRecent":
                    ClearRecentFiles();
                    break;
                case "openRecentFolder":
                    OpenRecentFolder(root.GetProperty("path").GetString(),
                        root.TryGetProperty("relPath", out JsonElement recentRel) && JsonValueKind.String == recentRel.ValueKind
                            ? recentRel.GetString() : null, IsNewWindowRequested(root));
                    break;
                case "clearRecentFolders":
                    ClearRecentFolders();
                    break;
                case "close":
                    // メニュー「閉じる」（Ctrl+W）：このウィンドウを閉じる（保存していない変更があれば OnClosing で確認する）
                    Close();
                    break;
                case "openReadme":
                    // メニュー「ヘルプ」→「Readmeを開く」（F1）
                    OpenReadme();
                    break;
            }
        }

        // ===== Excel 等とのコピー・貼り付け（web\js\clipboard.js） =====

        /// <summary>Excel 等へ貼り付ける画像を置く一時フォルダ（mde と同じく、コピーのたびに古いものを消す）。</summary>
        private static readonly string s_clipboardTempDir = Path.Combine(Path.GetTempPath(), Program.AssemblyName, "clipboard_images");

        /// <summary>「Excel用にコピー」「表をコピー」：HTML（CF_HTML）と文字をクリップボードに書き込む（mde の
        /// ClipboardHtmlBuilder・TableEditor と同じ形）。画面側（WebView2）が書き込むと、HTML に元のページの場所
        /// （https://app.mdew/…）が付き、Excel がインターネット上のページとして扱って PC の中の画像を読み込まないため、
        /// ここで書き込む。画像（file:///…）は、mde と同じく一時フォルダへコピーしてから参照させる。</summary>
        /// <param name="a_html">HTML の断片（表）。</param>
        /// <param name="a_text">文字（改行は LF）。</param>
        private void CopyHtml(string a_html, string a_text)
        {
            string html = System.Text.RegularExpressions.Regex.Replace(a_html, "(<img\\b[^>]*?\\bsrc=\")([^\"]*)(\")",
                m => m.Groups[1].Value + System.Net.WebUtility.HtmlEncode(CopyImageForClipboard(System.Net.WebUtility.HtmlDecode(m.Groups[2].Value))) + m.Groups[3].Value,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var data = new DataObject();
            data.SetData(DataFormats.UnicodeText, (a_text ?? string.Empty).Replace("\r\n", "\n").Replace("\n", "\r\n"));
            data.SetData(DataFormats.Html, BuildHtmlClipboardFragment(html));
            // ほかのアプリがクリップボードを開いている時は失敗するので、少し待って何回か試す
            for (int i = 0; ; i++)
            {
                try
                {
                    Clipboard.SetDataObject(data, true);
                    return;
                }
                catch (Exception ex) when (i < 5)
                {
                    ErrorLog.Write("クリップボードに書き込めませんでした（再試行）", ex);
                    System.Threading.Thread.Sleep(50);
                }
            }
        }

        /// <summary>Excel 等に貼り付ける画像を一時フォルダへコピーし、その file:/// の URL を返す（mde の
        /// ImageManager.WriteTempFileForClipboard と同じ）。ファイル名は英数字だけにし、同じ画像を何か所に
        /// 貼っても Excel が1つにまとめないよう、ファイルの末尾に無害なバイトを足して中身を毎回変える（BMP を除く）。
        /// file:/// 以外（http 等）・コピーできない場合は、そのまま返す。</summary>
        /// <param name="a_url">画像の参照先。</param>
        /// <returns>一時フォルダの画像の URL。</returns>
        private static string CopyImageForClipboard(string a_url)
        {
            try
            {
                if (!Uri.TryCreate(a_url, UriKind.Absolute, out Uri uri) || !uri.IsFile || !File.Exists(uri.LocalPath))
                {
                    return a_url;
                }
                Directory.CreateDirectory(s_clipboardTempDir);
                DateTime cutoff = DateTime.Now.AddMinutes(-10);
                foreach (string old in Directory.GetFiles(s_clipboardTempDir))
                {
                    try
                    {
                        if (File.GetLastWriteTime(old) < cutoff) File.Delete(old);
                    }
                    catch (Exception)
                    {
                        // 使用中等で消せないファイルは、次の機会に消す
                    }
                }
                string ext = Path.GetExtension(uri.LocalPath).ToLowerInvariant();
                string dest = Path.Combine(s_clipboardTempDir, Guid.NewGuid().ToString("N") + ext);
                File.Copy(uri.LocalPath, dest, true);
                if (".bmp" != ext)
                {
                    using var stream = new FileStream(dest, FileMode.Append, FileAccess.Write);
                    stream.Write(Guid.NewGuid().ToByteArray());
                }
                return new Uri(dest).AbsoluteUri;
            }
            catch (Exception)
            {
                return a_url;
            }
        }

        /// <summary>HTML の断片を、クリップボードの CF_HTML の形（位置の見出しと &lt;html&gt;&lt;body&gt; で囲んだもの）にする
        /// （mde の TableEditor.BuildHtmlClipboardFragment と同じ。元のページの場所 SourceURL は付けない）。</summary>
        /// <param name="a_fragment">HTML の断片。</param>
        /// <returns>CF_HTML の文字列。</returns>
        private static string BuildHtmlClipboardFragment(string a_fragment)
        {
            const string HTML_PREFIX = "<html><body><!--StartFragment-->";
            const string HTML_SUFFIX = "<!--EndFragment--></body></html>";
            const string HEADER_TEMPLATE = "Version:0.9\r\nStartHTML:{0:0000000000}\r\nEndHTML:{1:0000000000}\r\n" +
                "StartFragment:{2:0000000000}\r\nEndFragment:{3:0000000000}\r\n";
            int startHtml = Encoding.UTF8.GetByteCount(string.Format(HEADER_TEMPLATE, 0, 0, 0, 0));
            int startFragment = startHtml + Encoding.UTF8.GetByteCount(HTML_PREFIX);
            int endFragment = startFragment + Encoding.UTF8.GetByteCount(a_fragment);
            int endHtml = endFragment + Encoding.UTF8.GetByteCount(HTML_SUFFIX);
            return string.Format(HEADER_TEMPLATE, startHtml, endHtml, startFragment, endFragment) + HTML_PREFIX + a_fragment + HTML_SUFFIX;
        }

        /// <summary>他のアプリが置いた画像のファイル（Excel でコピーした範囲の画像の一時ファイル等。file:///…）を、
        /// 貼り付けた画像の一時フォルダへコピーする（保存する時に「&lt;ファイル名&gt;.images」へ移る）。
        /// Excel の一時ファイルは後で消されるため、貼り付けた時点でコピーしておく。結果は imagesImported で返す。</summary>
        /// <param name="a_id">HTML 側が付けた要求の番号（そのまま返す）。</param>
        /// <param name="a_srcs">画像の参照先の配列。</param>
        private void ImportImages(int a_id, JsonElement a_srcs)
        {
            var urls = new System.Collections.Generic.List<string>();
            foreach (JsonElement item in a_srcs.EnumerateArray())
            {
                string url = null;
                try
                {
                    string src = item.GetString();
                    if (Uri.TryCreate(src, UriKind.Absolute, out Uri uri) && uri.IsFile && File.Exists(uri.LocalPath) &&
                        s_imageTypes.ContainsKey(Path.GetExtension(uri.LocalPath)))
                    {
                        Directory.CreateDirectory(m_tempImageDir);
                        string ext = Path.GetExtension(uri.LocalPath).ToLowerInvariant();
                        string fileName = GenerateSequentialFileName(m_tempImageDir, PASTED_IMAGE_BASE_NAME, ext);
                        File.Copy(uri.LocalPath, Path.Combine(m_tempImageDir, fileName));
                        url = $"https://{TMP_HOST}/{Uri.EscapeDataString(fileName)}";
                    }
                }
                catch (Exception ex)
                {
                    ErrorLog.Write("貼り付けた画像をコピーできませんでした", ex);
                }
                urls.Add(url);
            }
            Post(new { cmd = "imagesImported", id = a_id, urls });
        }

        // ===== 最近使ったファイル（メニュー「ファイル」→「最近使ったファイル」。mde と同じ） =====

        /// <summary>最近使ったファイルとして覚えておく数（mde と同じ）。</summary>
        private const int MAX_RECENT_FILES = 10;

        /// <summary>最近使ったファイル・フォルダの一覧を HTML 側へ送る（recentFiles。メニューを開いた時に表示する）。</summary>
        /// <param name="a_settings">設定（一覧を持つもの）。</param>
        private void PostRecentFiles(AppSettings a_settings)
        {
            Post(new { cmd = "recentFiles", files = a_settings.RecentFiles, folders = a_settings.RecentFolders });
        }

        /// <summary>開いたフォルダを、最近使ったフォルダの先頭に加える（AddRecentFile と同じ。10 個まで）。</summary>
        /// <param name="a_folder">フォルダのパス。</param>
        private void AddRecentFolder(string a_folder)
        {
            string full;
            try
            {
                full = Path.GetFullPath(a_folder);
            }
            catch (Exception)
            {
                return;
            }
            var settings = AppSettings.Load();
            settings.RecentFolders.RemoveAll(p => string.Equals(p, full, StringComparison.OrdinalIgnoreCase));
            settings.RecentFolders.Insert(0, full);
            if (settings.RecentFolders.Count > MAX_RECENT_FILES)
            {
                settings.RecentFolders.RemoveRange(MAX_RECENT_FILES, settings.RecentFolders.Count - MAX_RECENT_FILES);
            }
            settings.Save();
            PostRecentFiles(settings);
        }

        /// <summary>最近使ったフォルダを開く（「フォルダを開く...」でそのフォルダを選んだのと同じ）。フォルダが無い
        /// （移動・削除された）場合は、そのことを知らせて一覧から消す。保存していない変更の確認は、HTML 側で済ませている。</summary>
        /// <param name="a_folder">フォルダのパス。</param>
        /// <param name="a_relPath">今のファイルの、今のフォルダからの相対パス（OpenFolder と同じ。無ければ null）。</param>
        /// <param name="a_newWindow">新しいウィンドウで開くか（main.js の opensInNewWindow）。</param>
        private void OpenRecentFolder(string a_folder, string a_relPath, bool a_newWindow)
        {
            if (Directory.Exists(a_folder))
            {
                if (a_newWindow) OpenNewWindow(a_folder);
                else OpenFolderPath(a_folder, a_relPath);
                return;
            }
            var settings = AppSettings.Load();
            settings.RecentFolders.RemoveAll(p => string.Equals(p, a_folder, StringComparison.OrdinalIgnoreCase));
            settings.Save();
            PostRecentFiles(settings);
            Post(new { cmd = "error", message = $"フォルダが見つかりませんでした。\n{a_folder}" });
        }

        /// <summary>最近使ったフォルダの「履歴をクリア」：一覧を空にする。</summary>
        private void ClearRecentFolders()
        {
            var settings = AppSettings.Load();
            settings.RecentFolders.Clear();
            settings.Save();
            PostRecentFiles(settings);
        }

        /// <summary>開いた・保存したファイルを、最近使ったファイルの先頭に加える（既にあれば先頭へ移す。
        /// 多すぎる分は古いものから消す）。一覧は設定ファイルに置き、ほかのウィンドウとも同じものを使う。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        private void AddRecentFile(string a_path)
        {
            string full;
            try
            {
                full = Path.GetFullPath(a_path);
            }
            catch (Exception)
            {
                return;
            }
            var settings = AppSettings.Load();
            settings.RecentFiles.RemoveAll(p => string.Equals(p, full, StringComparison.OrdinalIgnoreCase));
            settings.RecentFiles.Insert(0, full);
            if (settings.RecentFiles.Count > MAX_RECENT_FILES)
            {
                settings.RecentFiles.RemoveRange(MAX_RECENT_FILES, settings.RecentFiles.Count - MAX_RECENT_FILES);
            }
            settings.Save();
            PostRecentFiles(settings);
        }

        /// <summary>最近使ったファイルを開く。ファイルが無い（移動・削除された）場合は、そのことを知らせて一覧から消す（mde と同じ）。
        /// 保存していない変更の確認は、HTML 側で済ませている。</summary>
        /// <param name="a_path">ファイルのパス。</param>
        /// <param name="a_newWindow">新しいウィンドウで開くか（main.js の opensInNewWindow）。</param>
        private void OpenRecentFile(string a_path, bool a_newWindow)
        {
            if (File.Exists(a_path))
            {
                if (a_newWindow) OpenNewWindow(a_path);
                else LoadFile(a_path);
                return;
            }
            var settings = AppSettings.Load();
            settings.RecentFiles.RemoveAll(p => string.Equals(p, a_path, StringComparison.OrdinalIgnoreCase));
            settings.Save();
            PostRecentFiles(settings);
            Post(new { cmd = "error", message = $"ファイルが見つかりませんでした。\n{a_path}" });
        }

        /// <summary>「履歴をクリア」：最近使ったファイルの一覧を空にする。</summary>
        private void ClearRecentFiles()
        {
            var settings = AppSettings.Load();
            settings.RecentFiles.Clear();
            settings.Save();
            PostRecentFiles(settings);
        }

        // ===== 画像を開く（web\js\editor.js の画像のダブルクリック・右クリックの「画像を開く」） =====

        /// <summary>画像を既定のアプリで開く（mde と同じ）。http・https の画像はブラウザで開く。
        /// それ以外は、貼り付けた画像（一時フォルダ）・file:///・絶対パス・開いているファイルのフォルダからの相対パスとして
        /// ファイルを探す。誤ってプログラム等を実行しないよう、画像の拡張子のファイルだけを開く。</summary>
        /// <param name="a_src">画像の参照先（文書に書かれたまま。貼り付けた画像は https://tmp.mdew/…）。</param>
        private void OpenImage(string a_src)
        {
            string src = (a_src ?? string.Empty).Trim();
            if (Uri.TryCreate(src, UriKind.Absolute, out Uri uri) && ("http" == uri.Scheme || "https" == uri.Scheme) &&
                !string.Equals(uri.Host, TMP_HOST, StringComparison.OrdinalIgnoreCase))
            {
                OpenUrl(src);
                return;
            }
            string path = ResolveImagePath(src);
            if (null == path || !File.Exists(path))
            {
                Post(new { cmd = "error", message = $"この画像は開けません（元のファイルが見つからないか、埋め込みの画像です）。\n{src}" });
                return;
            }
            if (!s_imageTypes.ContainsKey(Path.GetExtension(path)))
            {
                Post(new { cmd = "error", message = $"画像のファイルではないため開けません。\n{path}" });
                return;
            }
            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Post(new { cmd = "error", message = $"画像を開けませんでした。\n{path}\n{ex.Message}" });
            }
        }

        /// <summary>画像の参照先を、ファイルのパスにする（ファイルではない参照先・解決できない場合は null）。</summary>
        /// <param name="a_src">画像の参照先（文書に書かれたまま）。</param>
        /// <returns>ファイルのフルパス（存在するかは確かめない）。</returns>
        private string ResolveImagePath(string a_src)
        {
            try
            {
                if (a_src.StartsWith($"https://{TMP_HOST}/", StringComparison.OrdinalIgnoreCase))
                {
                    // 貼り付けた画像（まだ保存していない。このウィンドウの一時フォルダ）
                    string name = Path.GetFileName(Uri.UnescapeDataString(new Uri(a_src).AbsolutePath));
                    return 0 < name.Length ? Path.Combine(m_tempImageDir, name) : null;
                }
                if (a_src.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
                {
                    return new Uri(a_src).LocalPath;
                }
                if (a_src.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || a_src.StartsWith("//") ||
                    (Uri.TryCreate(a_src, UriKind.Absolute, out Uri uri) && !uri.IsFile))
                {
                    return null;
                }
                string pathPart = a_src.Split('?', '#')[0].Replace('/', Path.DirectorySeparatorChar);
                if (Path.IsPathRooted(pathPart) && pathPart.Length >= 2 && (':' == pathPart[1] || pathPart.StartsWith(@"\\")))
                {
                    return Path.GetFullPath(pathPart); // C:\dir\a.png・\\server\share\a.png
                }
                if (string.IsNullOrEmpty(m_docFolder))
                {
                    return null; // 保存していない文書の相対パス
                }
                string full = Path.GetFullPath(Path.Combine(m_docFolder, pathPart));
                // %20 等で書かれていれば、元の文字に戻したパスも試す
                return File.Exists(full) ? full : Path.GetFullPath(Path.Combine(m_docFolder, Uri.UnescapeDataString(pathPart)));
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ===== PDF に書き出す（メニュー「ファイル」→「PDFに書き出し…」・「PDFの余白を設定…」） =====

        /// <summary>PDF に書き出す。HTML 側が、書き出す内容を印刷用の要素（#print-doc）に表示してから exportPdf を送ってくる
        /// （印刷用の見た目は web\app.css の @media print）。保存先を選ぶダイアログを出し、WebView2 の PrintToPdfAsync で
        /// A4 縦・設定した余白で書き出して、書き出した PDF を既定のアプリで開く。終わったら pdfExported を送る。</summary>
        /// <param name="a_name">文書の名前（PDF のファイル名の初期値に使う。「無題」等）。</param>
        /// <returns>書き出しが終わるまでの非同期処理。</returns>
        private async System.Threading.Tasks.Task ExportPdfAsync(string a_name)
        {
            bool ok = false;
            try
            {
                string baseName = !string.IsNullOrEmpty(m_currentPath)
                    ? Path.GetFileNameWithoutExtension(m_currentPath)
                    : Path.GetFileNameWithoutExtension(string.IsNullOrEmpty(a_name) ? "無題" : a_name);
                var dialog = new SaveFileDialog
                {
                    Title = "PDFに書き出し",
                    Filter = "PDF ファイル (*.pdf)|*.pdf",
                    FileName = baseName + ".pdf",
                    DefaultExt = ".pdf",
                    AddExtension = true,
                };
                if (!string.IsNullOrEmpty(m_currentPath))
                {
                    dialog.InitialDirectory = Path.GetDirectoryName(m_currentPath);
                }
                if (true != dialog.ShowDialog(this))
                {
                    return;
                }
                var settings = AppSettings.Load(); // 他のウィンドウで余白を変えた場合も、最新の値を使う
                var core = m_webView.CoreWebView2;
                var print = core.Environment.CreatePrintSettings();
                print.Orientation = CoreWebView2PrintOrientation.Portrait;
                print.PageWidth = 8.27;   // A4（インチ）
                print.PageHeight = 11.69;
                print.MarginTop = settings.PdfMarginTop / 96.0;
                print.MarginBottom = settings.PdfMarginBottom / 96.0;
                print.MarginLeft = settings.PdfMarginLeft / 96.0;
                print.MarginRight = settings.PdfMarginRight / 96.0;
                print.ShouldPrintBackgrounds = true;
                print.ShouldPrintHeaderAndFooter = false;
                if (!await core.PrintToPdfAsync(dialog.FileName, print))
                {
                    Post(new { cmd = "error", message = $"PDFに書き出せませんでした（ファイルが他のアプリで開かれている等）。\n{dialog.FileName}" });
                    return;
                }
                ok = true;
                try
                {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(dialog.FileName) { UseShellExecute = true });
                }
                catch (Exception)
                {
                    // PDF を開くアプリが無い場合等。書き出しはできている
                }
            }
            catch (Exception ex)
            {
                ErrorLog.Write("PDFに書き出せませんでした", ex);
                Post(new { cmd = "error", message = $"PDFに書き出せませんでした。\n{ex.Message}" });
            }
            finally
            {
                Post(new { cmd = "pdfExported", ok });
            }
        }

        /// <summary>開いているメニューバーのメニュー（ShowWebMenu。開いていなければ null）。</summary>
        private System.Windows.Controls.ContextMenu m_webMenu;
        /// <summary>メニューバーのメニューの見た目（WebMenu.xaml。右クリックのメニュー（HTML）とそろえたもの）。</summary>
        private static ResourceDictionary s_webMenuStyles;
        /// <summary>メニューバーのメニューの枠の外側の、影を描くための透明な余白（WebMenu.xaml の WebMenuPanel と同じ）。</summary>
        private const double WEB_MENU_SHADOW = 12;

        /// <summary>メニューバーのメニューの見た目（WebMenu.xaml）を読み込む（初めて使う時に1回だけ）。</summary>
        private static ResourceDictionary WebMenuStyles =>
            s_webMenuStyles ??= (ResourceDictionary)Application.LoadComponent(new Uri("/mdew;component/WebMenu.xaml", UriKind.Relative));

        /// <summary>メニューバーのメニューを、WPF のメニュー（ContextMenu）で開く。HTML のメニューは
        /// ウィンドウの外へはみ出して表示できず、長いパスの「最近使ったファイル」等が省略されてしまうため。
        /// 見た目は、右クリックのメニュー（HTML）とそろえる（WebMenu.xaml）。
        /// 項目は HTML 側で作り（web\js\main.js の MENUS）、選ばれた項目の番号を menuSelected で返す。閉じたら menuClosed で
        /// 知らせる。開いている間に別のメニューのボタンへマウスを移した時・左右の矢印キーを押した時は、menuSwitch で
        /// 別のメニューを開いてもらう（Windows のメニューバーと同じ）。</summary>
        /// <param name="a_msg">showMenu のメッセージ（name：メニューの名前、x・y：開く位置（画面側の座標）、items：項目、
        /// buttons：メニューバーのボタンの名前と位置、keyboard：キーボードで開いたか）。</param>
        private void ShowWebMenu(JsonElement a_msg)
        {
            string name = a_msg.GetProperty("name").GetString();
            if (null != m_webMenu)
            {
                // 開いているメニューは、新しいメニューに置き換える。置き換えて閉じたメニューは、キーボードの入力先を WebView2 に
                // 戻さない（Tag に置き換え先のメニューの名前を入れておく。menu.Closed 参照）
                System.Windows.Controls.ContextMenu old = m_webMenu;
                m_webMenu = null;
                old.Tag = name;
                old.IsOpen = false;
            }
            var buttons = new System.Collections.Generic.List<(string Name, Rect Bounds, bool HasMenu)>();
            foreach (JsonElement b in a_msg.GetProperty("buttons").EnumerateArray())
            {
                double left = b.GetProperty("left").GetDouble();
                double top = b.GetProperty("top").GetDouble();
                bool hasMenu = b.TryGetProperty("menu", out JsonElement menuElement) && JsonValueKind.True == menuElement.ValueKind;
                buttons.Add((b.GetProperty("name").GetString(),
                    new Rect(left, top, b.GetProperty("right").GetDouble() - left, b.GetProperty("bottom").GetDouble() - top), hasMenu));
            }
            // 枠の外側の影の余白の分、左上へずらして、枠が指定の位置に来るようにする
            var menu = new System.Windows.Controls.ContextMenu
            {
                Style = (Style)WebMenuStyles["WebMenu"],
                PlacementTarget = m_webView,
                Placement = System.Windows.Controls.Primitives.PlacementMode.Relative,
                HorizontalOffset = a_msg.GetProperty("x").GetDouble() - WEB_MENU_SHADOW,
                VerticalOffset = a_msg.GetProperty("y").GetDouble() - WEB_MENU_SHADOW,
            };
            // 文字の色：画面側の文字の色（メニュー「表示」→「文字の色」。textColor）にそろえる。WebMenu.xaml の WebMenuText は
            // DynamicResource なので、このメニュー（とサブメニュー）の中だけ置き換わる。渡されなければ既定の色
            // 配色（ライト・ダーク）の色を入れる（Theme.cs。WebMenu.xaml の色は DynamicResource なので、このメニューの中だけ置き換わる）
            Theme.ApplyMenu(menu);
            System.Windows.Media.Brush textBrush = Theme.MenuTextBrush;
            if (a_msg.TryGetProperty("textColor", out JsonElement textColorElement) && JsonValueKind.String == textColorElement.ValueKind
                && !string.IsNullOrWhiteSpace(textColorElement.GetString()))
            {
                try
                {
                    var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(textColorElement.GetString());
                    textBrush = new System.Windows.Media.SolidColorBrush(color);
                }
                catch (Exception ex) when (ex is FormatException || ex is NotSupportedException || ex is NullReferenceException)
                {
                    // 色として読めなければ既定の色のまま
                }
            }
            menu.Resources["WebMenuText"] = textBrush;
            foreach (JsonElement item in a_msg.GetProperty("items").EnumerateArray())
            {
                menu.Items.Add(BuildWebMenuItem(item));
            }
            // 切り替え先のメニュー（閉じた後に menuSwitch で知らせる）
            string switchTo = null;
            bool switchByKeyboard = false;
            void SwitchTo(string a_name, bool a_keyboard)
            {
                switchTo = a_name;
                switchByKeyboard = a_keyboard;
                menu.IsOpen = false;
            }
            // 別のメニューのボタンへマウスを移したら、そのメニューに切り替える
            menu.PreviewMouseMove += (s, e) =>
            {
                Point p = e.GetPosition(m_webView);
                foreach (var (buttonName, bounds, _) in buttons)
                {
                    if (buttonName != name && bounds.Contains(p))
                    {
                        SwitchTo(buttonName, false);
                        return;
                    }
                }
            };
            // 左右の矢印キー：隣のメニューに切り替える（サブメニューの中・サブメニューを持つ項目での右は、サブメニューの操作）
            menu.PreviewKeyDown += (s, e) =>
            {
                if ((System.Windows.Input.Key.Left != e.Key && System.Windows.Input.Key.Right != e.Key) || buttons.Count < 2)
                {
                    return;
                }
                if (System.Windows.Input.Keyboard.FocusedElement is System.Windows.Controls.MenuItem focused &&
                    (!ReferenceEquals(System.Windows.Controls.ItemsControl.ItemsControlFromItemContainer(focused), menu) ||
                     (System.Windows.Input.Key.Right == e.Key && focused.HasItems)))
                {
                    return;
                }
                int index = buttons.FindIndex(b => b.Name == name);
                int next = (index + (System.Windows.Input.Key.Right == e.Key ? 1 : buttons.Count - 1)) % buttons.Count;
                e.Handled = true;
                SwitchTo(buttons[next].Name, true);
            };
            bool byKeyboard = a_msg.TryGetProperty("keyboard", out JsonElement keyboard) && keyboard.GetBoolean();
            if (byKeyboard)
            {
                // キーボードで開いた時は、最初の項目を選んだ状態にする（Windows のメニューと同じ）
                menu.Opened += (s, e) => Dispatcher.BeginInvoke(new Action(() =>
                    menu.MoveFocus(new System.Windows.Input.TraversalRequest(System.Windows.Input.FocusNavigationDirection.First))));
            }
            menu.Closed += (s, e) =>
            {
                if (menu.Tag is string replacedBy)
                {
                    // 別のメニューを開くために閉じた（ShowWebMenu で置き換えた）：キーボードの入力先は WebView2 に戻さない。
                    // 戻すと、WebView2 への入力先の移動が後から届いて、開いたばかりのメニューが閉じてしまうことがあるため。
                    // 同じメニューを開き直した時は、画面側のメニューの状態（開いているメニュー）を消さないよう、menuClosed も送らない
                    if (replacedBy != name)
                    {
                        Post(new { cmd = "menuClosed", name });
                    }
                    return;
                }
                if (ReferenceEquals(m_webMenu, menu))
                {
                    m_webMenu = null;
                }
                // キーボードの入力先を WebView2 に戻す。ただし、別のメニューに切り替える時は戻さない（すぐに次のメニューを
                // 開いて、ShowWebMenu で入力先を移すため。戻すと、上と同じく次のメニューが閉じてしまうことがある）。
                // 「検索と置換」のようにメニューを持たないボタンへ切り替える時は戻す（画面側でそのボタンを選んだ状態にする）
                bool switchToMenu = null != switchTo && buttons.Exists(b => b.Name == switchTo && b.HasMenu);
                if (!switchToMenu)
                {
                    m_webView.Focus();
                }
                Post(new { cmd = "menuClosed", name });
                if (null != switchTo)
                {
                    Post(new { cmd = "menuSwitch", name = switchTo, keyboard = switchByKeyboard });
                }
            };
            m_webMenu = menu;
            // キーボードの入力先を、WebView2（ブラウザのウィンドウ）からこのウィンドウの見えない要素に移してから開く
            // （WPF のメニューのキーボード操作は、このウィンドウに届いたキーで動くため。移さないと、矢印キー等が WebView2 に
            // 届いて、メニューの項目間を移動できない）。閉じたら WebView2 に戻す（menu.Closed）
            System.Windows.Input.Keyboard.Focus(m_focusSink);
            menu.IsOpen = true;
        }

        /// <summary>メニューバーのメニューの項目を作る（ShowWebMenu）。</summary>
        /// <param name="a_item">項目（null：区切り線。label・key（ショートカットの表示）・checked・disabled・title（説明）・
        /// heading（選べない見出し）・submenu（サブメニューの項目）・id（選ばれた時に返す番号））。</param>
        /// <returns>項目（MenuItem か Separator）。</returns>
        private object BuildWebMenuItem(JsonElement a_item)
        {
            if (JsonValueKind.Null == a_item.ValueKind)
            {
                return new System.Windows.Controls.Separator { Style = (Style)WebMenuStyles["WebMenuSeparator"] };
            }
            string text = a_item.GetProperty("label").GetString();
            if (a_item.TryGetProperty("heading", out JsonElement heading) && heading.GetBoolean())
            {
                // 選べない見出し（下の項目のまとまりの名前）
                return new System.Windows.Controls.MenuItem { Header = text, Style = (Style)WebMenuStyles["WebMenuHeading"] };
            }
            // 「_」はアクセスキーの印になるので、「__」にして文字のまま表示する
            var menuItem = new System.Windows.Controls.MenuItem
            {
                Header = text.Replace("_", "__"),
                Style = (Style)WebMenuStyles["WebMenuItem"],
            };
            if (a_item.TryGetProperty("key", out JsonElement key))
            {
                menuItem.InputGestureText = key.GetString();
            }
            menuItem.IsChecked = a_item.TryGetProperty("checked", out JsonElement isChecked) && isChecked.GetBoolean();
            menuItem.IsEnabled = !(a_item.TryGetProperty("disabled", out JsonElement disabled) && disabled.GetBoolean());
            if (a_item.TryGetProperty("title", out JsonElement title))
            {
                menuItem.ToolTip = title.GetString();
            }
            if (a_item.TryGetProperty("submenu", out JsonElement submenu))
            {
                foreach (JsonElement child in submenu.EnumerateArray())
                {
                    menuItem.Items.Add(BuildWebMenuItem(child));
                }
            }
            else if (a_item.TryGetProperty("id", out JsonElement id))
            {
                int itemId = id.GetInt32();
                menuItem.Click += (s, e) => Post(new { cmd = "menuSelected", id = itemId });
            }
            return menuItem;
        }


        /// <summary>右クリックのメニュー「表を挿入…」：行数・列数を指定するダイアログ（mde と同じ）を出し、結果を HTML 側に
        /// tableSize で知らせる（表は HTML 側で、右クリックした段落の後ろに挿入する）。</summary>
        private void ShowTableSizeDialog()
        {
            var tableDialog = new dialog.TableSizeDialog { Owner = this };
            bool ok = true == tableDialog.ShowDialog();
            // ダイアログを閉じた後、すぐに表の中へ書けるよう、編集領域にキーボードの入力先を戻す
            m_webView.Focus();
            // 取りやめた時も知らせる（HTML 側で、挿入する位置として覚えておいた段落を忘れるため）。行数・列数が 0 なら取りやめ
            Post(new { cmd = "tableSize", rows = ok ? tableDialog.Rows : 0, cols = ok ? tableDialog.Columns : 0 });
        }

        /// <summary>右クリックのメニュー「リンクにする…」：リンク先の URL を入力するダイアログ（mde と同じ）を出し、結果を
        /// HTML 側に linkUrl で知らせる（リンクは HTML 側で、右クリックした時に選んでいた文字に付ける）。</summary>
        private void ShowLinkDialog()
        {
            var linkDialog = new dialog.LinkInputDialog { Owner = this };
            bool ok = true == linkDialog.ShowDialog();
            m_webView.Focus();
            // 取りやめた時・URL が空の時も知らせる（HTML 側で、覚えておいた選択範囲を忘れるため）。url が空なら取りやめ
            Post(new { cmd = "linkUrl", url = ok ? linkDialog.Url : "" });
        }

        /// <summary>メニュー「PDFの余白を設定…」。設定した余白は、すぐに設定ファイルに保存する（次に書き出す時から使う）。</summary>
        private void ShowPdfMarginDialog()
        {
            var settings = AppSettings.Load();
            var marginDialog = new dialog.PdfMarginDialog(settings.PdfMarginTop, settings.PdfMarginBottom, settings.PdfMarginLeft,
                settings.PdfMarginRight) { Owner = this };
            if (true != marginDialog.ShowDialog())
            {
                return;
            }
            settings.PdfMarginTop = marginDialog.MarginTop;
            settings.PdfMarginBottom = marginDialog.MarginBottom;
            settings.PdfMarginLeft = marginDialog.MarginLeft;
            settings.PdfMarginRight = marginDialog.MarginRight;
            settings.Save();
        }

        // ===== 検索と置換のウィンドウ（dialog\FindReplaceWindow。処理は web\js\find.js） =====

        /// <summary>検索と置換のウィンドウ（初めて開く時に作る。閉じても隠すだけなので、入力した内容は残る）。</summary>
        private dialog.FindReplaceWindow m_findWindow;
        /// <summary>フォルダを開いているか（検索の対象に「フォルダ全体」を選べるか）。</summary>
        private bool m_folderOpen;

        /// <summary>検索と置換のウィンドウを開く（開いていれば手前に出して、検索する文字列の入力欄に移る）。
        /// メインのウィンドウの外へも動かせる。メインのウィンドウを閉じると一緒に閉じる。</summary>
        /// <param name="a_selectedText">編集領域で範囲選択していた文字列（検索する文字列に入れる。無ければ null か ''）。</param>
        private void ShowFindWindow(string a_selectedText = null)
        {
            if (null == m_findWindow)
            {
                m_findWindow = new dialog.FindReplaceWindow(SendFindCommand) { Owner = this };
            }
            m_findWindow.SetFolderAvailable(m_folderOpen);
            m_findWindow.ShowAndFocus(a_selectedText);
        }

        /// <summary>検索と置換のウィンドウでの操作を、入力された内容と一緒に HTML 側へ送る（findCommand）。</summary>
        /// <param name="a_action">操作（prev・next・all・replaceAll・stepStart・stepDo・stepSkip・stepRest・stepEnd・openResult・close）。</param>
        /// <param name="a_index">openResult の時、選ばれた結果の番号（それ以外は -1）。</param>
        private void SendFindCommand(string a_action, int a_index)
        {
            var w = m_findWindow;
            Post(new
            {
                cmd = "findCommand", action = a_action, query = w.Query, replacement = w.Replacement,
                folder = w.FolderScope, matchCase = w.MatchCase, regex = w.UseRegex, index = a_index,
            });
            if ("close" == a_action)
            {
                // 閉じたら、編集領域にキーボードの入力先を戻す
                Activate();
                m_webView.Focus();
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
        /// <param name="a_newWindow">選んだフォルダを新しいウィンドウで開くか（main.js の opensInNewWindow）。</param>
        private void OpenFolder(string a_relPath, bool a_newWindow)
        {
            var dialog = new OpenFolderDialog { Title = "フォルダを開く" };
            if (true != dialog.ShowDialog(this))
            {
                return;
            }
            if (a_newWindow)
            {
                // 新しいウィンドウは、起動時引数のフォルダとして開く（OpenStartupPath → OpenFolderPath）
                OpenNewWindow(dialog.FolderName);
                return;
            }
            OpenFolderPath(dialog.FolderName, a_relPath);
        }

        /// <summary>メニューからファイル・フォルダを開く要求（open・openFolder・openRecent・openRecentFolder）で、
        /// 新しいウィンドウで開くよう指定されているか（newWindow: true。main.js の opensInNewWindow）。</summary>
        /// <param name="a_message">HTML 側から届いたメッセージ。</param>
        /// <returns>新しいウィンドウで開くなら true。</returns>
        private static bool IsNewWindowRequested(JsonElement a_message)
        {
            return a_message.TryGetProperty("newWindow", out JsonElement value) && JsonValueKind.True == value.ValueKind;
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
            m_folderOpen = true;
            m_findWindow?.SetFolderAvailable(true);
            Post(new { cmd = "folderOpened", root = folder, name = string.IsNullOrEmpty(name) ? folder : name });
            AddRecentFolder(folder);
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
        /// <param name="a_path">新しいウィンドウで開くファイルのパス（省略時は何も開かない＝新規）。</param>
        private void OpenNewWindow(string a_path = null)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath) { UseShellExecute = false };
                string placement = PlacementForNewWindow();
                if (null != placement)
                {
                    psi.ArgumentList.Add(PLACEMENT_OPTION + placement);
                }
                if (null != a_path)
                {
                    psi.ArgumentList.Add(a_path);
                }
                System.Diagnostics.Process.Start(psi);
            }
            catch (Exception ex)
            {
                ErrorLog.Write("新しいウィンドウを開けませんでした", ex);
                Post(new { cmd = "error", message = $"新しいウィンドウを開けませんでした。\n{ex.Message}" });
            }
        }

        /// <summary>「ヘルプ」→「Readmeを開く」（F1）：実行フォルダの README.md（mdew.csproj の設定で、ビルド時に
        /// リポジトリ直下の README.md がコピーされる。インストーラーでもインストール先に置く）を、新しいウィンドウで開く
        /// （mde と同じ。今のウィンドウで開いているファイルには触れない）。検索と置換等のダイアログで F1 を押した時は、
        /// Program.Main で登録したハンドラーから、ダイアログの Owner のこのウィンドウに対して呼ばれる。</summary>
        public void OpenReadme()
        {
            string readmePath = Path.Combine(AppContext.BaseDirectory, "README.md");
            if (!File.Exists(readmePath))
            {
                MessageBox.Show(this, "README.md が見つかりませんでした：" + readmePath, "Readmeを開く",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            OpenNewWindow(readmePath);
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
            // ファイルを開けた時は、画面に表示し終えた時（DocumentTitleChanged）に起動時間を記録する
            m_startupLoadPending = null != m_currentPath;
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
                AddRecentFile(a_path);
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
                AddRecentFile(path);
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
                // いったん閉じるのをやめ、保存していない内容を HTML 側に問い合わせる（confirmClose）。返事が届いたら、
                // ConfirmClose で「閉じる前に保存しますか？」を出す（保存する内容・ファイル名は HTML 側にあるため）
                a_args.Cancel = true;
                QueryUnsavedForClose();
                return;
            }
            if (null != m_findWindow)
            {
                m_findWindow.AllowClose = true;
                m_findWindow.Close();
            }
            SaveWindowPlacement();
        }

        /// <summary>閉じる時の確認のため、保存していない内容を HTML 側に問い合わせる（confirmClose を送る）。
        /// 画面が応答しない等で 3 秒たっても返事が無ければ、保存はできない旨の確認を出す（閉じられなくならないように）。</summary>
        private void QueryUnsavedForClose()
        {
            if (m_closeQueryPending)
            {
                return;
            }
            m_closeQueryPending = true;
            m_closeQueryTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            m_closeQueryTimer.Tick += (s, e) => ConfirmClose(null);
            m_closeQueryTimer.Start();
            try
            {
                Post(new { cmd = "confirmClose" });
            }
            catch (Exception ex)
            {
                ErrorLog.Write("閉じる時の問い合わせに失敗", ex);
                ConfirmClose(null);
            }
        }

        /// <summary>閉じる時の確認（「…は変更されています。閉じる前に保存しますか？」。Windows のメッセージボックス）を出す。
        /// はい：保存してから閉じる（保存先を選ぶダイアログでキャンセルした・保存に失敗した時は閉じない）。
        /// いいえ：保存せずに閉じる。キャンセル：閉じない。</summary>
        /// <param name="a_files">HTML 側から届いた、保存していない内容（path・markdown・images・current の配列。
        /// 開いているファイルが先頭）。HTML 側から返事が無かった時は null（保存はできないので、保存せずに閉じるかだけ確認する）。</param>
        private void ConfirmClose(JsonElement? a_files)
        {
            if (!m_closeQueryPending)
            {
                return;
            }
            m_closeQueryPending = false;
            m_closeQueryTimer?.Stop();
            m_closeQueryTimer = null;

            // 変更されているファイルの名前（多い時は 4 個まで出して、残りは「ほか n 個のファイル」）
            var names = new System.Collections.Generic.List<string>();
            if (a_files.HasValue)
            {
                foreach (JsonElement f in a_files.Value.EnumerateArray())
                {
                    string path = f.GetProperty("path").GetString();
                    names.Add(string.IsNullOrEmpty(path) ? "無題" : Path.GetFileName(path));
                }
                if (0 == names.Count)
                {
                    // 問い合わせている間に保存された等で、保存していない内容が無くなった
                    m_closeConfirmed = true;
                    Close();
                    return;
                }
            }
            else
            {
                names.Add(string.IsNullOrEmpty(m_currentPath) ? "無題" : Path.GetFileName(m_currentPath));
            }
            var lines = new StringBuilder();
            for (int i = 0; i < names.Count; i++)
            {
                if (4 == i && 5 < names.Count)
                {
                    lines.Append($"ほか {names.Count - 4} 個のファイル\n");
                    break;
                }
                lines.Append(names[i]).Append('\n');
            }
            string message = a_files.HasValue
                ? lines + "は変更されています。閉じる前に保存しますか？"
                : lines + "は変更されています。\n画面が応答しないため保存できません。保存せずに閉じますか？";

            // Windows のメッセージボックスで確認する（はい・いいえ・キャンセル。既定は「はい」）。新しい見た目で表示されるよう、
            // app.manifest でコモンコントロール 6 を使う設定にしている
            if (!a_files.HasValue)
            {
                // HTML 側から返事が無い：保存はできないので、保存せずに閉じるかだけ確認する（既定は「いいえ」）
                if (MessageBoxResult.Yes == MessageBox.Show(this, message, Program.AppName, MessageBoxButton.YesNo,
                    MessageBoxImage.Question, MessageBoxResult.No))
                {
                    m_closeConfirmed = true;
                    Close();
                }
                return;
            }
            MessageBoxResult result = MessageBox.Show(this, message, Program.AppName, MessageBoxButton.YesNoCancel,
                MessageBoxImage.Question, MessageBoxResult.Yes);
            if (MessageBoxResult.No == result)
            {
                m_closeConfirmed = true;
                Close();
            }
            else if (MessageBoxResult.Yes == result)
            {
                SaveForClose(a_files.Value);
            }
        }

        /// <summary>閉じる時の確認で「はい」：保存していない内容をすべて保存し、すべて保存できたら閉じる。
        /// 開いているファイルは SaveFile（新規の文書は保存先を選ぶ。キャンセルしたら閉じない）、それ以外のファイル
        /// （フォルダを開いている時に、保存せずに置いておいた内容）は WriteOtherFile で書き出す（SaveAll と同じ）。
        /// 保存に失敗したファイルがあれば、savedAll で知らせて閉じない。</summary>
        /// <param name="a_files">保存する内容（path・markdown・images・current の配列）。</param>
        private void SaveForClose(JsonElement a_files)
        {
            var saved = new System.Collections.Generic.List<string>();
            var failed = new System.Collections.Generic.List<object>();
            foreach (JsonElement f in a_files.EnumerateArray())
            {
                string path = f.GetProperty("path").GetString();
                string markdown = f.GetProperty("markdown").GetString();
                if (f.TryGetProperty("current", out JsonElement currentElement) && currentElement.GetBoolean())
                {
                    var images = new System.Collections.Generic.List<string>();
                    if (f.TryGetProperty("images", out JsonElement imagesElement) && JsonValueKind.Array == imagesElement.ValueKind)
                    {
                        foreach (JsonElement item in imagesElement.EnumerateArray()) images.Add(item.GetString());
                    }
                    if (SaveFile(markdown, false, images, out string error))
                    {
                        saved.Add(m_currentPath);
                        continue;
                    }
                    if (null == error)
                    {
                        return; // 保存先を選ぶダイアログでキャンセルした：閉じない（ほかのファイルも保存しない）
                    }
                    failed.Add(new { path = string.IsNullOrEmpty(path) ? "(無題)" : path, message = error });
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
            if (0 == failed.Count)
            {
                m_closeConfirmed = true;
                Close();
                return;
            }
            Post(new { cmd = "savedAll", saved, failed });
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
            // 他のウィンドウで変えた設定（PDF の余白等）を消さないよう、設定ファイルを読み直してから書き換える
            RECT r = wp.rcNormalPosition;
            var settings = AppSettings.Load();
            settings.Window = new WindowBounds { Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Bottom };
            settings.IsMaximized = SW_SHOWMAXIMIZED == wp.showCmd ||
                (SW_SHOWMINIMIZED == wp.showCmd && 0 != (wp.flags & WPF_RESTORETOMAXIMIZED));
            settings.Save();
        }
    }

    /// <summary>起動にかかった時間（プロセスの開始からの時間）を測り、error.log に 1 行で記録する（起動を速くするための確認用）。
    /// 例：「起動時間：Main=80ms ウィンドウ表示=310ms WebView2の環境=350ms WebView2の準備=520ms 画面の準備=700ms ファイル表示=730ms」
    ///   Main：.NET の起動が終わり、mdew の処理が始まった
    ///   ウィンドウ表示：ウィンドウが最初に表示された
    ///   WebView2の環境：裏で動く Edge のプロセスが起動した
    ///   WebView2の準備：ウィンドウの中の WebView2 が使えるようになった
    ///   キャッシュ削除：web フォルダのファイルが更新されていたので、ブラウザのキャッシュを消した（消さなかった時は出ない）
    ///   画面の準備：画面側（web\index.html・js）の準備ができた（ready）
    ///   ファイル表示：起動時引数のファイルを画面に表示した（ファイル無し：開くファイルが無かった）</summary>
    public static class StartupTiming
    {
        /// <summary>プロセスの開始日時。</summary>
        private static readonly DateTime s_processStart = System.Diagnostics.Process.GetCurrentProcess().StartTime;
        /// <summary>記録した時間（「名前=時間ms」を空白区切りで並べたもの）。</summary>
        private static readonly StringBuilder s_marks = new StringBuilder();
        /// <summary>記録し終えたか（2 回目以降の Mark・Finish は何もしない）。</summary>
        private static bool s_finished;

        /// <summary>今の時点の、プロセスの開始からの時間を覚えておく（TRACE_LOG の時だけ。それ以外は呼び出しごと無くなる）。</summary>
        /// <param name="a_name">時点の名前。</param>
        [System.Diagnostics.Conditional("TRACE_LOG")]
        public static void Mark(string a_name)
        {
            lock (s_marks)
            {
                if (!s_finished)
                {
                    s_marks.Append($" {a_name}={(DateTime.Now - s_processStart).TotalMilliseconds:0}ms");
                }
            }
        }

        /// <summary>今の時点を最後の時点として覚え、それまでの時間を error.log に記録する（TRACE_LOG の時だけ）。</summary>
        /// <param name="a_name">時点の名前。</param>
        [System.Diagnostics.Conditional("TRACE_LOG")]
        public static void Finish(string a_name)
        {
            string text;
            lock (s_marks)
            {
                if (s_finished)
                {
                    return;
                }
                s_marks.Append($" {a_name}={(DateTime.Now - s_processStart).TotalMilliseconds:0}ms");
                s_finished = true;
                text = s_marks.ToString();
            }
            ErrorLog.Trace($"起動時間：{text.TrimStart()}");
        }
    }

    /// <summary>ブラウザのキャッシュを消すかどうかを決めるための印（web フォルダのファイル・mdew.dll の更新日時と、
    /// アプリのバージョン）。前回キャッシュを消した時の印を %LOCALAPPDATA%\&lt;アセンブリ名&gt;\webcache.stamp に置き、
    /// 今の印と違う時（web フォルダのファイルを更新した・別のバージョンをインストールした・Debug と Release を切り替えた時等）
    /// だけキャッシュを消す。</summary>
    public static class WebCacheStamp
    {
        /// <summary>前回キャッシュを消した時の印を置くファイルのパス。</summary>
        private static readonly string s_path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "webcache.stamp");

        /// <summary>今の印を作る。</summary>
        /// <param name="a_webDir">web フォルダのパス。</param>
        /// <returns>印（作れなかった時は null。その時は毎回キャッシュを消す）。</returns>
        public static string Create(string a_webDir)
        {
            try
            {
                long newest = File.GetLastWriteTimeUtc(typeof(Program).Assembly.Location).Ticks;
                foreach (string file in Directory.EnumerateFiles(a_webDir, "*", SearchOption.AllDirectories))
                {
                    newest = Math.Max(newest, File.GetLastWriteTimeUtc(file).Ticks);
                }
                return $"{Program.Version} {AppContext.BaseDirectory} {newest}";
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>前回キャッシュを消した時から、印が変わったか。</summary>
        /// <param name="a_stamp">今の印（Create）。</param>
        /// <returns>変わった（または分からない）なら true（キャッシュを消す）。</returns>
        public static bool IsChanged(string a_stamp)
        {
            try
            {
                return null == a_stamp || !File.Exists(s_path) || a_stamp != File.ReadAllText(s_path);
            }
            catch (Exception)
            {
                return true;
            }
        }

        /// <summary>キャッシュを消した時の印を保存する。</summary>
        /// <param name="a_stamp">今の印（Create）。</param>
        public static void Save(string a_stamp)
        {
            if (null == a_stamp)
            {
                return;
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(s_path));
                File.WriteAllText(s_path, a_stamp);
            }
            catch (Exception)
            {
                // 保存できなくても、次回もキャッシュを消すだけ
            }
        }
    }

    /// <summary>エラー・起動・終了の記録。%LOCALAPPDATA%\&lt;アセンブリ名&gt;\error.log に追記する（1MB を超えたら作り直す）。
    /// 起動・終了・起動時間の記録は、コンパイルスイッチ TRACE_LOG の時だけ（Trace）。エラーが無ければ error.log は作らない。
    /// 「起動」の次に「終了」が無い記録は、そのとき異常終了（強制終了を含む）したことを表す（TRACE_LOG の時）。</summary>
    public static class ErrorLog
    {
        /// <summary>記録するファイルのパス。</summary>
        public static readonly string FilePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "error.log");

        /// <summary>動作の記録（起動・終了等。エラーではないもの）を 1 件記録する。コンパイルスイッチ TRACE_LOG を有効にして
        /// ビルドした時だけ記録する（mdew.csproj の TraceLog。無効の時は、呼び出しごと無くなる）。エラーが無ければ error.log を
        /// 作らないようにするため。</summary>
        /// <param name="a_message">内容。</param>
        [System.Diagnostics.Conditional("TRACE_LOG")]
        public static void Trace(string a_message)
        {
            Write(a_message, null);
        }

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
            StartupTiming.Mark("Main");
            // 起動を速くする：前回の起動で JIT コンパイルしたメソッドを記録しておき、次回の起動では、それを別のスレッドで
            // 先にコンパイルしておく（.NET のマルチコア JIT。記録は %LOCALAPPDATA%\<アセンブリ名>\startup.jitprofile）
            try
            {
                string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AssemblyName);
                Directory.CreateDirectory(profileDir);
                ProfileOptimization.SetProfileRoot(profileDir);
                ProfileOptimization.StartProfile("startup.jitprofile");
            }
            catch (Exception)
            {
                // 使えなくても動作には影響しない（起動が速くならないだけ）
            }
            var app = new Application();
            // 配色（ライト・ダーク）。すべてのウィンドウに、開いた時に色を入れる（Theme.cs）
            Theme.Initialize(AppSettings.Load().Theme);
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
            // F1 で「Readmeを開く」を、検索と置換・PDF の余白・バージョン情報のダイアログでも使えるようにする
            // （mde と同じ。Window クラス全体に登録するので、ダイアログを追加した時も個別の対応は要らない）。
            // メインのウィンドウ（WebView2）での F1 は、画面側（main.js）で受けるので、ここでは扱わない（二重に開かないように）
            EventManager.RegisterClassHandler(typeof(Window), UIElement.PreviewKeyDownEvent,
                new System.Windows.Input.KeyEventHandler((s, e) =>
                {
                    if (System.Windows.Input.Key.F1 != e.Key || s is MainWindow)
                    {
                        return;
                    }
                    // ダイアログは Owner＝開いた元のメインのウィンドウで作っているので、Owner をたどる
                    Window window = s as Window;
                    while (null != window && !(window is MainWindow))
                    {
                        window = window.Owner;
                    }
                    if (window is MainWindow mainWindow)
                    {
                        e.Handled = true;
                        mainWindow.OpenReadme();
                    }
                }));
            // 起動・終了の記録（TRACE_LOG の時だけ。ErrorLog.Trace）
            ErrorLog.Trace($"起動（v{Version}）");
            app.Exit += (s, e) => { ErrorLog.Trace($"終了（終了コード={e.ApplicationExitCode}）"); };
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
