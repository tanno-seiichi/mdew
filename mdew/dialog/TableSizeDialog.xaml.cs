using System.Windows;

namespace mdew.dialog
{
    /// <summary>
    /// 挿入する表の行数（見出しの行を含む）と列数を指定するダイアログ（mde の TableSizeDialog の移植）。
    /// 行数は 1〜50、列数は 1〜20 の範囲にし、数字でない場合は 1 にする（mde と同じ）。
    /// </summary>
    public partial class TableSizeDialog : Window
    {
        /// <summary>行数の最大値（mde と同じ）。</summary>
        private const int MAX_ROWS = 50;
        /// <summary>列数の最大値（mde と同じ）。</summary>
        private const int MAX_COLUMNS = 20;

        /// <summary>「挿入」を押した時の行数（見出しの行を含む）。</summary>
        public int Rows { get; private set; } = 3;
        /// <summary>「挿入」を押した時の列数。</summary>
        public int Columns { get; private set; } = 3;

        /// <summary>ダイアログを作る（行数・列数とも 3 を表示し、行数の欄を選択した状態にする）。</summary>
        public TableSizeDialog()
        {
            InitializeComponent();
            Loaded += (s, e) =>
            {
                m_rowsBox.Focus();
                m_rowsBox.SelectAll();
            };
        }

        /// <summary>「挿入」：入力された値を範囲に収めて、ダイアログを閉じる。</summary>
        /// <param name="a_sender">イベントの発生元。</param>
        /// <param name="a_args">イベントの引数。</param>
        private void OkClick(object a_sender, RoutedEventArgs a_args)
        {
            Rows = Clamp(m_rowsBox.Text, MAX_ROWS);
            Columns = Clamp(m_colsBox.Text, MAX_COLUMNS);
            DialogResult = true;
        }

        /// <summary>入力された文字を、1〜a_max の整数にする（数字でなければ 1）。</summary>
        /// <param name="a_text">入力された文字。</param>
        /// <param name="a_max">最大値。</param>
        /// <returns>範囲に収めた値。</returns>
        private static int Clamp(string a_text, int a_max)
        {
            if (!int.TryParse(a_text, out int value) || value < 1)
            {
                return 1;
            }
            return value > a_max ? a_max : value;
        }
    }
}
