// Theme.cs
//
// mdew の配色（ライト・ダーク）。メニュー「表示」→「テーマ」で、Windows の設定に合わせる・ライト・ダークを選ぶ。
// 編集画面（HTML。web\app.css の body.theme-dark）、メニューバーのメニュー（WebMenu.xaml）、ダイアログ（dialog\DialogStyles.xaml）、
// タイトルバーの色を合わせる。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;

namespace mdew
{
    /// <summary>
    /// mdew の配色。Windows の設定（「個人用設定」→「色」→「既定のアプリ モード」）に合わせるか、ライト・ダークに決める。
    /// すべてのウィンドウ（メインのウィンドウ・ダイアログ）に、開いた時（Loaded）と配色が変わった時に色を入れる。
    /// </summary>
    public static class Theme
    {
        /// <summary>Windows の設定に合わせる（既定）。</summary>
        public const string MODE_SYSTEM = "system";
        /// <summary>ライト。</summary>
        public const string MODE_LIGHT = "light";
        /// <summary>ダーク。</summary>
        public const string MODE_DARK = "dark";

        /// <summary>今の選び方（MODE_SYSTEM・MODE_LIGHT・MODE_DARK）。</summary>
        public static string Mode { get; private set; } = MODE_SYSTEM;
        /// <summary>今、暗い配色か。</summary>
        public static bool IsDark { get; private set; }
        /// <summary>配色が変わった時（UI スレッドで呼ぶ）。</summary>
        public static event Action Changed;

        // ===== 色 =====
        // 明るい配色の値は、dialog\DialogStyles.xaml・WebMenu.xaml の既定の色と同じ。暗い配色は Windows 11 のダークモードに近い色

        /// <summary>ダイアログの色（名前 → 明るい配色・暗い配色）。dialog\DialogStyles.xaml の同じ名前の色を置き換える。</summary>
        private static readonly Dictionary<string, (string Light, string Dark)> s_dialogColors = new Dictionary<string, (string, string)>
        {
            ["DlgWindowBackground"] = ("#FFFFFF", "#202020"),
            ["DlgText"] = ("#1C1C1C", "#F0F0F0"),
            ["DlgSubText"] = ("#555555", "#B4B4B4"),
            ["DlgStatusText"] = ("#666666", "#A8A8A8"),
            ["DlgDisabledText"] = ("#A0A0A0", "#6E6E6E"),
            ["DlgAccent"] = ("#0078D4", "#4CC2FF"),
            ["DlgAccentHover"] = ("#1A86D9", "#6CCBFF"),
            ["DlgOnAccent"] = ("#FFFFFF", "#000000"),
            ["DlgFocusBorder"] = ("#1C1C1C", "#F0F0F0"),
            ["DlgButtonBackground"] = ("#FDFDFD", "#2D2D2D"),
            ["DlgButtonHoverBackground"] = ("#E0EEF9", "#2F3B47"),
            ["DlgButtonPressedBackground"] = ("#CCE4F7", "#26323D"),
            ["DlgButtonHoverBorder"] = ("#0078D4", "#4CC2FF"),
            ["DlgButtonPressedBorder"] = ("#005499", "#3BA8E0"),
            ["DlgDisabledBackground"] = ("#F5F5F5", "#262626"),
            ["DlgDisabledBorder"] = ("#E5E5E5", "#333333"),
            ["DlgInputBackground"] = ("#FFFFFF", "#2B2B2B"),
            ["DlgInputHoverBackground"] = ("#FAFAFA", "#323232"),
            ["DlgInputFocusBackground"] = ("#FFFFFF", "#1F1F1F"),
            ["DlgBoxBackground"] = ("#FDFDFD", "#2B2B2B"),
            ["DlgBoxBorder"] = ("#8A8A8A", "#9A9A9A"),
            ["DlgBoxHoverBackground"] = ("#F0F0F0", "#363636"),
            ["DlgBoxPressedBackground"] = ("#E5E5E5", "#3C3C3C"),
            ["DlgBoxDisabled"] = ("#C5C5C5", "#555555"),
            ["DlgChevron"] = ("#5F5F5F", "#B4B4B4"),
            ["DlgListBackground"] = ("#FFFFFF", "#2B2B2B"),
            ["DlgListBorder"] = ("#D0D0D0", "#444444"),
            ["DlgItemHover"] = ("#F0F0F0", "#363636"),
            ["DlgItemSelected"] = ("#CCE4F7", "#264F78"),
            ["DlgInfoBackground"] = ("#EEF4FB", "#1E2A36"),
            ["DlgInfoBorder"] = ("#C8DCF0", "#2F4A63"),
            ["DlgInfoLink"] = ("#0B62C4", "#4DAAFC"),
            ["DlgScrollTrack"] = ("#FCFCFC", "#2E2E2E"),
            ["DlgScrollThumb"] = ("#8B8B8B", "#9F9F9F"),
            ["DlgScrollThumbHover"] = ("#6E6E6E", "#BDBDBD"),
            ["DlgScrollThumbPressed"] = ("#5A5A5A", "#D0D0D0"),
        };

        /// <summary>ダイアログの、下側だけ少し濃い枠の色（名前 → 明るい配色・暗い配色の (上・左右の色, 下の色, 色を変える位置)）。</summary>
        private static readonly Dictionary<string, ((string, string, double) Light, (string, string, double) Dark)> s_dialogBorders =
            new Dictionary<string, ((string, string, double), (string, string, double))>
            {
                ["DlgButtonBorder"] = (("#D0D0D0", "#BABABA", 0.92), ("#444444", "#3A3A3A", 0.92)),
                ["DlgDefaultButtonBorder"] = (("#0078D4", "#006BBE", 0.92), ("#4CC2FF", "#3BA8E0", 0.92)),
                ["DlgInputBorder"] = (("#D0D0D0", "#8A8A8A", 0.93), ("#444444", "#9A9A9A", 0.93)),
            };

        /// <summary>メニューバーのメニューの色（WebMenu.xaml の同じ名前の色を置き換える）。HTML の右クリックのメニュー
        /// （theme のメッセージの menu…）とそろえる。</summary>
        private static readonly Dictionary<string, (string Light, string Dark)> s_menuColors = new Dictionary<string, (string, string)>
        {
            ["WebMenuText"] = ("#1C1C1C", "#F0F0F0"),
            ["WebMenuBackground"] = ("#FFFFFF", "#2B2B2B"),
            ["WebMenuBorder"] = ("#C8CCD1", "#454545"),
            ["WebMenuHighlight"] = ("#E8F0FE", "#094771"),
            ["WebMenuCheck"] = ("#0B62C4", "#4DAAFC"),
            ["WebMenuSub"] = ("#888888", "#9A9A9A"),
            ["WebMenuDisabled"] = ("#AAAAAA", "#6E6E6E"),
            ["WebMenuDisabledSub"] = ("#BBBBBB", "#5E5E5E"),
            ["WebMenuSeparatorLine"] = ("#E3E5E8", "#454545"),
        };

        /// <summary>暗い配色の時の、編集画面（HTML）の色（web\app.css の body.theme-dark の --vs-…）。</summary>
        private const string DARK_BACKGROUND = "#1F1F1F";
        private const string DARK_TEXT = "#E0E0E0";
        private const string DARK_BORDER = "#3C3C3C";

        // ===== 始める・切り替える =====

        /// <summary>初めに1回呼ぶ（App を作った後）。すべてのウィンドウに、開いた時に色を入れるようにし、Windows の設定の
        /// 変更を受け取る。</summary>
        /// <param name="a_mode">設定に保存してある選び方（AppSettings.Theme）。</param>
        public static void Initialize(string a_mode)
        {
            Mode = Normalize(a_mode);
            IsDark = Evaluate();
            EventManager.RegisterClassHandler(typeof(Window), FrameworkElement.LoadedEvent, new RoutedEventHandler((s, e) =>
            {
                if (s is Window window && ReferenceEquals(window, e.OriginalSource))
                {
                    Apply(window);
                }
            }));
            // Windows の「既定のアプリ モード」を変えた時（UserPreferenceCategory.General で届く）
            SystemEvents.UserPreferenceChanged += (s, e) =>
            {
                if (UserPreferenceCategory.General == e.Category)
                {
                    Application.Current?.Dispatcher.BeginInvoke(new Action(() => Update(false)));
                }
            };
        }

        /// <summary>選び方を変える（メニュー「表示」→「テーマ」。保存は呼び出し側で行う）。</summary>
        /// <param name="a_mode">MODE_SYSTEM・MODE_LIGHT・MODE_DARK。</param>
        public static void SetMode(string a_mode)
        {
            Mode = Normalize(a_mode);
            Update(true);
        }

        /// <summary>選び方の文字列を、決まった値にする（知らない値は MODE_SYSTEM）。</summary>
        public static string Normalize(string a_mode)
        {
            return MODE_LIGHT == a_mode || MODE_DARK == a_mode ? a_mode : MODE_SYSTEM;
        }

        /// <summary>今の選び方で、暗い配色にするか。</summary>
        private static bool Evaluate()
        {
            return MODE_DARK == Mode || (MODE_SYSTEM == Mode && IsSystemDark());
        }

        /// <summary>Windows の「既定のアプリ モード」がダークか。</summary>
        private static bool IsSystemDark()
        {
            try
            {
                object value = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                    "AppsUseLightTheme", 1);
                return value is int light && 0 == light;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>配色を決め直し、変わった時（a_always の時は変わらなくても）、開いているすべてのウィンドウに色を入れ直して知らせる。</summary>
        private static void Update(bool a_always)
        {
            bool dark = Evaluate();
            if (dark == IsDark && !a_always)
            {
                return;
            }
            IsDark = dark;
            foreach (Window window in Application.Current.Windows)
            {
                Apply(window);
            }
            Changed?.Invoke();
        }

        // ===== 色を入れる =====

        /// <summary>ウィンドウ（メインのウィンドウ・ダイアログ）に、今の配色の色を入れる（ダイアログの部品の色・背景・タイトルバー）。</summary>
        /// <param name="a_window">ウィンドウ。</param>
        public static void Apply(Window a_window)
        {
            foreach (KeyValuePair<string, (string Light, string Dark)> color in s_dialogColors)
            {
                a_window.Resources[color.Key] = MakeBrush(IsDark ? color.Value.Dark : color.Value.Light);
            }
            foreach (KeyValuePair<string, ((string, string, double) Light, (string, string, double) Dark)> border in s_dialogBorders)
            {
                (string top, string bottom, double offset) = IsDark ? border.Value.Dark : border.Value.Light;
                var brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
                brush.GradientStops.Add(new GradientStop(ToColor(top), 0));
                brush.GradientStops.Add(new GradientStop(ToColor(top), offset));
                brush.GradientStops.Add(new GradientStop(ToColor(bottom), offset + 0.04));
                brush.Freeze();
                a_window.Resources[border.Key] = brush;
            }
            // 文字の色を指定していない文字（「検索する文字列」等の見出し）は、ウィンドウの文字の色になるので、暗い配色の時は
            // 明るい色にする（明るい配色の時は、今までどおり既定の色）
            if (IsDark)
            {
                a_window.SetResourceReference(System.Windows.Controls.Control.ForegroundProperty, "DlgText");
            }
            else
            {
                a_window.ClearValue(System.Windows.Controls.Control.ForegroundProperty);
            }
            SetDarkTitleBar(a_window, IsDark);
        }

        /// <summary>メニューバーのメニュー（WebMenu.xaml）に、今の配色の色を入れる（Program.cs の ShowWebMenu）。</summary>
        /// <param name="a_menu">メニュー。</param>
        public static void ApplyMenu(FrameworkElement a_menu)
        {
            foreach (KeyValuePair<string, (string Light, string Dark)> color in s_menuColors)
            {
                a_menu.Resources[color.Key] = MakeBrush(IsDark ? color.Value.Dark : color.Value.Light);
            }
        }

        /// <summary>メニューバーのメニューの、既定の文字の色。</summary>
        public static Brush MenuTextBrush => MakeBrush(IsDark ? s_menuColors["WebMenuText"].Dark : s_menuColors["WebMenuText"].Light);

        /// <summary>編集画面（WebView2）の背景の色（画面を表示する前・読み込み中に見える色）。</summary>
        public static System.Drawing.Color WebBackground =>
            IsDark ? System.Drawing.ColorTranslator.FromHtml(DARK_BACKGROUND) : System.Drawing.Color.White;

        /// <summary>
        /// 画面側に送る配色（theme のメッセージ。web\js\main.js の applyTheme）。mode は今の選び方（メニューの ✓ に使う）。
        /// 暗い配色の時は、背景・文字・枠線の色と、右クリックのメニューの色（メニューバーのメニューと同じ）を送る。
        /// </summary>
        public static object CreateMessage()
        {
            if (!IsDark)
            {
                return new { cmd = "theme", mode = Mode, dark = false };
            }
            return new
            {
                cmd = "theme",
                mode = Mode,
                dark = true,
                bg = DARK_BACKGROUND,
                fg = DARK_TEXT,
                border = DARK_BORDER,
                menuBg = s_menuColors["WebMenuBackground"].Dark,
                menuFg = s_menuColors["WebMenuText"].Dark,
                menuBorder = s_menuColors["WebMenuBorder"].Dark,
                menuHover = s_menuColors["WebMenuHighlight"].Dark,
                menuHoverFg = "#FFFFFF",
                menuSep = s_menuColors["WebMenuSeparatorLine"].Dark,
            };
        }

        /// <summary>色（#RRGGBB）のブラシ。</summary>
        private static Brush MakeBrush(string a_color)
        {
            var brush = new SolidColorBrush(ToColor(a_color));
            brush.Freeze();
            return brush;
        }

        /// <summary>#RRGGBB を色にする。</summary>
        private static Color ToColor(string a_color)
        {
            return (Color)ColorConverter.ConvertFromString(a_color);
        }

        // ===== タイトルバー =====

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr a_window, int a_attribute, ref int a_value, int a_size);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr a_window, IntPtr a_insertAfter, int a_x, int a_y, int a_cx, int a_cy, uint a_flags);

        /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODE（Windows 10 20H1 以降。それより前は 19）。</summary>
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;
        private const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_FRAMECHANGED = 0x0020;

        /// <summary>タイトルバーを暗い色・明るい色にする（ウィンドウが作られる前は何もしない。Loaded の時にまた呼ばれる）。</summary>
        private static void SetDarkTitleBar(Window a_window, bool a_dark)
        {
            IntPtr handle = new WindowInteropHelper(a_window).Handle;
            if (IntPtr.Zero == handle)
            {
                return;
            }
            int value = a_dark ? 1 : 0;
            if (0 != DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int)))
            {
                DwmSetWindowAttribute(handle, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref value, sizeof(int));
            }
            // 表示中のウィンドウのタイトルバーを描き直す
            SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
}
