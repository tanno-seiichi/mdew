using System.Windows;

namespace mdew.dialog
{
    /// <summary>
    /// リンク先の URL を入力するダイアログ（mde の LinkInputDialog の移植）。前後の空白は取り除く。
    /// </summary>
    public partial class LinkInputDialog : Window
    {
        /// <summary>OK を押した時の URL（前後の空白を取り除いたもの）。</summary>
        public string Url { get; private set; } = "";

        /// <summary>ダイアログを作る（URL の欄に、指定した URL を入れて選択した状態にする）。</summary>
        /// <param name="a_initialUrl">最初に表示する URL（新しいリンクは空）。</param>
        public LinkInputDialog(string a_initialUrl = "")
        {
            InitializeComponent();
            m_urlBox.Text = a_initialUrl;
            Loaded += (s, e) =>
            {
                m_urlBox.Focus();
                m_urlBox.SelectAll();
            };
        }

        /// <summary>OK：入力された URL を受け取って、ダイアログを閉じる。</summary>
        /// <param name="a_sender">イベントの発生元。</param>
        /// <param name="a_args">イベントの引数。</param>
        private void OkClick(object a_sender, RoutedEventArgs a_args)
        {
            Url = m_urlBox.Text.Trim();
            DialogResult = true;
        }
    }
}
