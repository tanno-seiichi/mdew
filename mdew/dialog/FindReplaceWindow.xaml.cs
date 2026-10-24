using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

namespace mdew.dialog
{
    /// <summary>
    /// 検索と置換のウィンドウ（mde の FindReplaceWindow と同じ見た目・項目）。メインのウィンドウの外へも動かせる。
    /// 入力と結果の表示だけを受け持ち、ボタンが押されたら、その命令（action）を MainWindow 経由で画面側
    /// （web\js\find.js の FindEngine.handle）へ送る。画面側の処理の結果（状態の文・結果の一覧・1件ずつ置換の欄）は
    /// ApplyUpdate で受け取って表示する。閉じても破棄せずに隠すだけにして、検索条件を次に開いた時まで残す（mde と同じ）。
    /// </summary>
    public partial class FindReplaceWindow : Window
    {
        /// <summary>命令を画面側へ送る処理（action と、一覧の行の番号。番号を使わない命令は -1）。</summary>
        private readonly Action<string, int> m_onCommand;

        /// <summary>結果の一覧の高さの上限（XAML の MaxHeight）。ウィンドウの大きさを変えた時になくし、「すべて検索」で
        /// ウィンドウの高さを中身に合わせ直す時に戻す（FitHeightToContent）。</summary>
        private readonly double m_resultsListMaxHeight;

        /// <summary>本当に閉じてよいか（メインのウィンドウを閉じる時だけ true にする。それ以外は隠すだけ）。</summary>
        public bool AllowClose { get; set; }

        /// <summary>ウィンドウを作る。</summary>
        /// <param name="a_onCommand">命令を画面側へ送る処理。</param>
        public FindReplaceWindow(Action<string, int> a_onCommand)
        {
            InitializeComponent();
            m_onCommand = a_onCommand;
            m_resultsListMaxHeight = m_resultsList.MaxHeight;
            // 利用者がウィンドウの大きさを変えると（WPF が SizeToContent を Manual にする）、結果の一覧の高さの上限（MaxHeight。
            // 開いた時に中身に合わせて大きくなりすぎないためのもの）をなくし、一覧がウィンドウの高さに合わせて伸び縮みするようにする
            SizeChanged += (s, e) =>
            {
                if (SizeToContent.Manual == SizeToContent)
                {
                    m_resultsList.ClearValue(MaxHeightProperty);
                }
            };
        }

        /// <summary>検索する文字列。</summary>
        public string Query => m_searchBox.Text;
        /// <summary>置換後の文字列。</summary>
        public string Replacement => m_replaceBox.Text;
        /// <summary>対象範囲がフォルダ全体か。</summary>
        public bool FolderScope => true == m_scopeFolder.IsChecked;
        /// <summary>大文字・小文字を区別するか。</summary>
        public bool MatchCase => true == m_caseSensitiveBox.IsChecked;
        /// <summary>正規表現を使うか。</summary>
        public bool UseRegex => true == m_useRegexBox.IsChecked;

        /// <summary>「フォルダ全体」を選べるかを、フォルダを開いているかに合わせる（開いていなければ「現在のファイル」）。</summary>
        /// <param name="a_available">フォルダを開いているか。</param>
        public void SetFolderAvailable(bool a_available)
        {
            m_scopeFolder.IsEnabled = a_available;
            if (!a_available)
            {
                m_scopeCurrentFile.IsChecked = true;
            }
        }

        /// <summary>ウィンドウを表示して前に出し、検索する文字列の欄を選択した状態にする。</summary>
        /// <param name="a_selectedText">編集領域で範囲選択していた文字列。空でなければ、検索する文字列の欄に入れる
        /// （「正規表現を使用する」がオンの時は、そのままの文字列を探すよう、記号をエスケープして入れる）。</param>
        public void ShowAndFocus(string a_selectedText = null)
        {
            if (!IsVisible)
            {
                // メインのウィンドウの横（右に空きがあれば右、無ければ左、どちらも無ければメインのウィンドウの右上の内側）に開く
                PlaceBesideOwner();
                Show();
                AdjustToVisibleFrame();
            }
            if (!string.IsNullOrEmpty(a_selectedText))
            {
                m_searchBox.Text = UseRegex ? System.Text.RegularExpressions.Regex.Escape(a_selectedText) : a_selectedText;
            }
            Activate();
            m_searchBox.Focus();
            m_searchBox.SelectAll();
        }

        // ===== 開く位置 =====

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr a_window, int a_flags);

        [DllImport("user32.dll")]
        private static extern bool GetMonitorInfo(IntPtr a_monitor, ref MONITORINFO a_info);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr a_window, out RECT a_rect);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr a_window, int a_attribute, out RECT a_rect, int a_size);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetricsForDpi(int a_index, uint a_dpi);

        private const int MONITOR_DEFAULTTONEAREST = 2;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int SM_CXSIZEFRAME = 32;
        private const int SM_CXPADDEDBORDER = 92;
        /// <summary>メインのウィンドウの内側に開く時の、メインのウィンドウの端からの間隔（WPF の単位）。</summary>
        private const double INSIDE_MARGIN = 12;
        /// <summary>右に寄せる時の間隔（WPF の単位）：メインのウィンドウとの間隔の最大と、画面の右端との間隔。</summary>
        private const double RIGHT_GAP = 4;

        /// <summary>開く位置を決めるための、メインのウィンドウの見えている枠の右端・画面（タスクバーを除く）の左端と右端・
        /// 開く位置の上端・間隔（すべて物理的な画素）。PlaceBesideOwner で決め、開いた後に AdjustToVisibleFrame で、実際の
        /// 幅で左端を決め直す。null：決めていない（メインのウィンドウの情報が取れなかった）。</summary>
        private (double OwnerRight, double WorkLeft, double WorkRight, double Top, double Margin, double Gap)? m_placement;

        /// <summary>
        /// 開く位置の左端（見えている枠。物理的な画素）。
        /// 基準は、メインのウィンドウの右上の内側（右に、メインのウィンドウの端が少し見える間隔を空ける）。
        /// メインのウィンドウの右に空きがあれば、右へずらす：メインのウィンドウとの間隔は最大で RIGHT_GAP、画面の右端との間に
        /// RIGHT_GAP を空ける（空きが足りなければ、メインのウィンドウに重ねる）。
        /// メインのウィンドウの右端が画面の右端に着いている（はみ出している）時は、基準の位置（画面からはみ出さないように）。
        /// </summary>
        /// <param name="a_width">このウィンドウの見えている幅。</param>
        private double VisibleLeft(double a_width)
        {
            var (ownerRight, workLeft, workRight, _, margin, gap) = m_placement.Value;
            double left = Math.Min(ownerRight, workRight) - margin - a_width; // 基準
            if (ownerRight < workRight)
            {
                left = Math.Max(left, Math.Min(ownerRight + gap, workRight - gap - a_width));
            }
            return Math.Max(left, workLeft);
        }

        /// <summary>ウィンドウの見えている枠（Windows 10・11 の、見えない縁を除いた枠。物理的な画素）と、ウィンドウの大きさ。</summary>
        private static bool GetFrames(IntPtr a_handle, out RECT a_window, out RECT a_visible)
        {
            a_visible = default;
            if (!GetWindowRect(a_handle, out a_window))
            {
                return false;
            }
            if (0 != DwmGetWindowAttribute(a_handle, DWMWA_EXTENDED_FRAME_BOUNDS, out a_visible, Marshal.SizeOf<RECT>()))
            {
                a_visible = a_window;
            }
            return true;
        }

        /// <summary>
        /// 開く位置を決める：上端は、メインのウィンドウ（Owner）の上の端が少し見える位置。左端は VisibleLeft。
        /// 開く前は、このウィンドウの見えない縁の幅が分からないので、Windows の既定の幅で仮に置く（開いた後に AdjustToVisibleFrame で合わせる）。
        /// </summary>
        private void PlaceBesideOwner()
        {
            m_placement = null;
            if (!(Owner is Window owner))
            {
                return;
            }
            IntPtr ownerHandle = new WindowInteropHelper(owner).Handle;
            PresentationSource source = PresentationSource.FromVisual(owner);
            var monitorInfo = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (IntPtr.Zero == ownerHandle || null == source?.CompositionTarget ||
                !GetMonitorInfo(MonitorFromWindow(ownerHandle, MONITOR_DEFAULTTONEAREST), ref monitorInfo) ||
                !GetFrames(ownerHandle, out _, out RECT visible))
            {
                return;
            }
            // 画面の位置は、すべて物理的な画素で計算する
            Matrix toDevice = source.CompositionTarget.TransformToDevice;
            RECT work = monitorInfo.rcWork;
            // このウィンドウの見えない縁の幅（仮。Windows の既定の幅）と、見えている幅
            uint dpi = (uint)Math.Round(96 * toDevice.M11);
            double border = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
            double width = Width * toDevice.M11 - 2 * border;
            // 上端は、メインのウィンドウの上の端が少し見える位置
            double top = Math.Max(visible.Top, work.Top) + INSIDE_MARGIN * toDevice.M11;
            m_placement = (visible.Right, work.Left, work.Right, top, INSIDE_MARGIN * toDevice.M11, RIGHT_GAP * toDevice.M11);
            double left = VisibleLeft(width);
            // 仮の位置（見えない縁は左右・下だけ。上には無い）
            Point position = source.CompositionTarget.TransformFromDevice.Transform(new Point(left - border, top));
            Left = position.X;
            Top = position.Y;
        }

        /// <summary>開いた後、このウィンドウの実際の見えない縁の幅で、見えている枠が決めた位置に来るよう合わせ直す。
        /// また、下端が画面（タスクバーを除く）からはみ出していたら、上へずらす。</summary>
        private void AdjustToVisibleFrame()
        {
            IntPtr handle = new WindowInteropHelper(this).Handle;
            PresentationSource source = PresentationSource.FromVisual(this);
            var monitorInfo = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (IntPtr.Zero == handle || null == source?.CompositionTarget ||
                !GetMonitorInfo(MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST), ref monitorInfo) ||
                !GetFrames(handle, out RECT window, out RECT visible))
            {
                return;
            }
            double left = window.Left;
            double top = window.Top;
            if (m_placement.HasValue)
            {
                // 実際の見えている幅で、左端を決め直す
                left = VisibleLeft(visible.Right - visible.Left) - (visible.Left - window.Left);
                top = m_placement.Value.Top - (visible.Top - window.Top);
            }
            // 下端がはみ出す分だけ上へ（見えている枠の上端が画面の上端より上にならない範囲で）
            double overflow = top + (visible.Bottom - window.Top) - monitorInfo.rcWork.Bottom;
            if (0 < overflow)
            {
                double visibleTop = top + (visible.Top - window.Top);
                top -= Math.Min(overflow, Math.Max(0, visibleTop - monitorInfo.rcWork.Top));
            }
            Point position = source.CompositionTarget.TransformFromDevice.Transform(new Point(left, top));
            Left = position.X;
            Top = position.Y;
        }

        /// <summary>画面側の処理の結果を表示する（{status}・{results, selectedIndex}・{selectedIndex}・{step}。find.js の post）。</summary>
        /// <param name="a_update">表示を更新する内容（findUpdate のメッセージ）。</param>
        public void ApplyUpdate(JsonElement a_update)
        {
            if (a_update.TryGetProperty("status", out JsonElement status))
            {
                m_statusText.Text = status.GetString() ?? string.Empty;
            }
            if (a_update.TryGetProperty("results", out JsonElement results))
            {
                m_resultsList.Items.Clear();
                if (JsonValueKind.Array == results.ValueKind)
                {
                    foreach (JsonElement item in results.EnumerateArray())
                    {
                        m_resultsList.Items.Add(item.GetString());
                    }
                    m_resultsList.Visibility = Visibility.Visible;
                }
                else
                {
                    m_resultsList.Visibility = Visibility.Collapsed;
                }
            }
            if (a_update.TryGetProperty("selectedIndex", out JsonElement selected) && JsonValueKind.Number == selected.ValueKind)
            {
                int index = selected.GetInt32();
                m_resultsList.SelectedIndex = index < m_resultsList.Items.Count ? index : -1;
                if (0 <= m_resultsList.SelectedIndex)
                {
                    m_resultsList.ScrollIntoView(m_resultsList.SelectedItem);
                }
            }
            if (a_update.TryGetProperty("step", out JsonElement step))
            {
                if (JsonValueKind.Object == step.ValueKind)
                {
                    m_stepFileText.Text = step.TryGetProperty("file", out JsonElement file) ? file.GetString() : string.Empty;
                    m_stepContextText.Text = step.TryGetProperty("context", out JsonElement context) ? context.GetString() : string.Empty;
                    m_stepPanel.Visibility = Visibility.Visible;
                }
                else
                {
                    m_stepPanel.Visibility = Visibility.Collapsed;
                }
            }
        }

        /// <summary>閉じる時：本当には閉じずに隠し、画面側に色を消させる（メインのウィンドウを閉じる時は本当に閉じる）。</summary>
        /// <param name="a_args">イベントの情報。</param>
        protected override void OnClosing(CancelEventArgs a_args)
        {
            base.OnClosing(a_args);
            if (AllowClose)
            {
                return;
            }
            a_args.Cancel = true;
            Hide();
            m_onCommand("close", -1);
            Owner?.Activate();
        }

        /// <summary>ウィンドウの高さを、開いた時と同じく中身に合わせた高さに戻す（大きさを変えた後でも、「すべて検索」で
        /// 結果の数に合った高さになるように）。幅は変えない。</summary>
        private void FitHeightToContent()
        {
            m_resultsList.MaxHeight = m_resultsListMaxHeight;
            SizeToContent = SizeToContent.Height;
        }

        /// <summary>前を検索。</summary>
        private void FindPreviousClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("prev", -1);
        /// <summary>次を検索。</summary>
        private void FindNextClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("next", -1);
        /// <summary>すべて検索（Enter でも実行する）。</summary>
        private void FindAllClick(object a_sender, RoutedEventArgs a_args)
        {
            FitHeightToContent();
            m_onCommand("all", -1);
        }
        /// <summary>1件ずつ置換…。</summary>
        private void StepReplaceClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("stepStart", -1);
        /// <summary>すべて置換。</summary>
        private void ReplaceAllClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("replaceAll", -1);
        /// <summary>1件ずつ置換：置換。</summary>
        private void StepReplaceOneClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("stepDo", -1);
        /// <summary>1件ずつ置換：スキップ。</summary>
        private void StepSkipClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("stepSkip", -1);
        /// <summary>1件ずつ置換：残りをすべて置換。</summary>
        private void StepReplaceRemainingClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("stepRest", -1);
        /// <summary>1件ずつ置換：終了。</summary>
        private void StepEndClick(object a_sender, RoutedEventArgs a_args) => m_onCommand("stepEnd", -1);

        /// <summary>結果の一覧のダブルクリック：その箇所・ファイルへ移動する。</summary>
        /// <param name="a_sender">一覧。</param>
        /// <param name="a_args">イベントの情報。</param>
        private void ResultsListMouseDoubleClick(object a_sender, MouseButtonEventArgs a_args)
        {
            if (0 <= m_resultsList.SelectedIndex)
            {
                m_onCommand("openResult", m_resultsList.SelectedIndex);
            }
        }

        /// <summary>「置換後の文字列」を開いた時だけ、置換のボタンを表示する（mde と同じ）。</summary>
        /// <param name="a_sender">Expander。</param>
        /// <param name="a_args">イベントの情報。</param>
        private void ReplaceExpanderToggled(object a_sender, RoutedEventArgs a_args)
        {
            Visibility v = m_replaceExpander.IsExpanded ? Visibility.Visible : Visibility.Collapsed;
            m_stepReplaceButton.Visibility = v;
            m_replaceAllButton.Visibility = v;
        }

        /// <summary>Esc：閉じる（隠す）。</summary>
        /// <param name="a_sender">ウィンドウ。</param>
        /// <param name="a_args">キーの情報。</param>
        private void FindReplaceWindowPreviewKeyDown(object a_sender, KeyEventArgs a_args)
        {
            if (Key.Escape == a_args.Key)
            {
                a_args.Handled = true;
                Close();
            }
        }
    }
}
