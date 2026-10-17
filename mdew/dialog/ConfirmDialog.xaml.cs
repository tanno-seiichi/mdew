using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace mdew.dialog
{
    /// <summary>
    /// 確認のダイアログ（はい・いいえ・キャンセル）。見た目は Windows のメッセージボックスに合わせ、アイコンは OS 標準の
    /// 「？」を使う。押したボタンは Result で受け取る
    /// （Esc キー・閉じるボタンはキャンセル）。
    /// </summary>
    public partial class ConfirmDialog : Window
    {
        /// <summary>押したボタン。</summary>
        public enum Answer
        {
            /// <summary>キャンセル（Esc キー・閉じるボタンも）。</summary>
            Cancel,
            /// <summary>はい。</summary>
            Yes,
            /// <summary>いいえ。</summary>
            No,
        }

        /// <summary>押したボタン（ダイアログを閉じた後に見る）。</summary>
        public Answer Result { get; private set; } = Answer.Cancel;

        /// <summary>ダイアログを作る。</summary>
        /// <param name="a_message">メッセージ（\n で改行する）。</param>
        /// <param name="a_showNo">「いいえ」のボタンを出すか（false なら「はい」・「キャンセル」だけ）。</param>
        public ConfirmDialog(string a_message, bool a_showNo = true)
        {
            InitializeComponent();
            m_message.Text = a_message;
            if (!a_showNo)
            {
                m_noButton.Visibility = Visibility.Collapsed;
            }
            Loaded += (s, e) =>
            {
                m_icon.Source = LoadQuestionIcon(VisualTreeHelper.GetDpi(this).DpiScaleX);
                m_yesButton.Focus();
            };
            // Y・N キーで「はい」・「いいえ」（メッセージボックスと同じく、Alt キーを押さなくても効く）
            PreviewKeyDown += (s, e) =>
            {
                Key key = Key.ImeProcessed == e.Key ? e.ImeProcessedKey : e.Key;
                if (ModifierKeys.None != (Keyboard.Modifiers & ~ModifierKeys.Alt))
                {
                    return;
                }
                if (Key.Y == key)
                {
                    e.Handled = true;
                    YesClick(this, null);
                }
                else if (Key.N == key && Visibility.Visible == m_noButton.Visibility)
                {
                    e.Handled = true;
                    NoClick(this, null);
                }
            };
        }

        /// <summary>はい：Result を Yes にして閉じる。</summary>
        /// <param name="a_sender">イベントの発生元。</param>
        /// <param name="a_args">イベントの引数。</param>
        private void YesClick(object a_sender, RoutedEventArgs a_args)
        {
            Result = Answer.Yes;
            DialogResult = true;
        }

        /// <summary>いいえ：Result を No にして閉じる。</summary>
        /// <param name="a_sender">イベントの発生元。</param>
        /// <param name="a_args">イベントの引数。</param>
        private void NoClick(object a_sender, RoutedEventArgs a_args)
        {
            Result = Answer.No;
            DialogResult = true;
        }

        // ===== OS 標準の「？」のアイコン =====
        /// <summary>OS 標準の「？」のアイコン（IDI_QUESTION）。</summary>
        private const int IDI_QUESTION = 32514;
        /// <summary>シェルの標準のアイコンの「？」（SIID_HELP）。</summary>
        private const uint SIID_HELP = 23;
        /// <summary>SHGetStockIconInfo で、アイコンの場所（ファイル・番号）を受け取る（SHGSI_ICONLOCATION）。</summary>
        private const uint SHGSI_ICONLOCATION = 0;
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SHSTOCKICONINFO
        {
            public uint cbSize;
            public IntPtr hIcon;
            public int iSysImageIndex;
            public int iIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szPath;
        }
        [DllImport("shell32.dll")] private static extern int SHGetStockIconInfo(uint a_siid, uint a_flags, ref SHSTOCKICONINFO a_info);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHDefExtractIcon(string a_iconFile, int a_index, uint a_flags, out IntPtr a_large, out IntPtr a_small, uint a_iconSize);
        [DllImport("user32.dll")] private static extern IntPtr LoadIcon(IntPtr a_instance, IntPtr a_name);
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr a_icon);
        [DllImport("comctl32.dll")] private static extern int LoadIconWithScaleDown(IntPtr a_instance, IntPtr a_name, int a_cx, int a_cy, out IntPtr a_icon);

        /// <summary>OS 標準の「？」のアイコンを、画面の拡大率に合った大きさで読み込む。
        /// Windows 11 のメッセージボックスと同じ平らなアイコンになるよう、シェルの標準のアイコン（SIID_HELP）を先に使う。
        /// 読み込めなければ、ウィンドウの標準のアイコン（IDI_QUESTION。Windows 11 では古い立体的なもの）を使う：
        /// 拡大率に合わせた大きさで読み込める LoadIconWithScaleDown（コモンコントロール 6 で使える）を先に試し、
        /// 使えなければ LoadIcon（システムの拡大率の大きさ）で読み込む。</summary>
        /// <param name="a_scale">画面の拡大率（1.0 = 100%）。</param>
        /// <returns>アイコンの画像（読み込めなければ null）。</returns>
        private static ImageSource LoadQuestionIcon(double a_scale)
        {
            int size = (int)Math.Round(32 * a_scale);
            ImageSource shellIcon = LoadShellHelpIcon(size);
            if (null != shellIcon)
            {
                return shellIcon;
            }
            IntPtr icon = IntPtr.Zero;
            bool mustDestroy = false;
            try
            {
                if (0 == LoadIconWithScaleDown(IntPtr.Zero, (IntPtr)IDI_QUESTION, size, size, out icon))
                {
                    mustDestroy = true;
                }
                else
                {
                    icon = IntPtr.Zero;
                }
            }
            catch (Exception ex) when (ex is EntryPointNotFoundException || ex is DllNotFoundException)
            {
                icon = IntPtr.Zero;
            }
            if (IntPtr.Zero == icon)
            {
                icon = LoadIcon(IntPtr.Zero, (IntPtr)IDI_QUESTION); // 共有のアイコン（破棄しない）
            }
            if (IntPtr.Zero == icon)
            {
                return null;
            }
            try
            {
                BitmapSource image = Imaging.CreateBitmapSourceFromHIcon(icon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                image.Freeze();
                return image;
            }
            finally
            {
                if (mustDestroy)
                {
                    DestroyIcon(icon);
                }
            }
        }

        /// <summary>シェルの標準のアイコンの「？」（SIID_HELP）を、指定した大きさで読み込む。</summary>
        /// <param name="a_size">大きさ（ピクセル）。</param>
        /// <returns>アイコンの画像（読み込めなければ null）。</returns>
        private static ImageSource LoadShellHelpIcon(int a_size)
        {
            try
            {
                var info = new SHSTOCKICONINFO { cbSize = (uint)Marshal.SizeOf<SHSTOCKICONINFO>() };
                if (0 != SHGetStockIconInfo(SIID_HELP, SHGSI_ICONLOCATION, ref info) || string.IsNullOrEmpty(info.szPath))
                {
                    return null;
                }
                // 大きいアイコンの大きさは下位 16 ビット、小さいアイコンの大きさは上位 16 ビットで指定する
                if (0 != SHDefExtractIcon(info.szPath, info.iIcon, 0, out IntPtr large, out IntPtr small, (uint)a_size | (16u << 16))
                    || IntPtr.Zero == large)
                {
                    return null;
                }
                try
                {
                    BitmapSource image = Imaging.CreateBitmapSourceFromHIcon(large, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                    image.Freeze();
                    return image;
                }
                finally
                {
                    DestroyIcon(large);
                    if (IntPtr.Zero != small) DestroyIcon(small);
                }
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
