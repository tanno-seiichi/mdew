using System;
using System.Globalization;
using System.Windows;

namespace mdew.dialog
{
    /// <summary>
    /// PDF に書き出す時の、上下左右の余白（px。1px = 1/96 インチ）を設定するダイアログ（mde の PdfMarginDialog の移植）。
    /// 0〜300 の範囲にし、数字でない場合は既定値にする（mde と同じ）。
    /// </summary>
    public partial class PdfMarginDialog : Window
    {
        /// <summary>上の余白の既定値（px。mde と同じ）。</summary>
        public const double DEFAULT_TOP = 64;
        /// <summary>下の余白の既定値（px）。</summary>
        public const double DEFAULT_BOTTOM = 64;
        /// <summary>左の余白の既定値（px）。</summary>
        public const double DEFAULT_LEFT = 80;
        /// <summary>右の余白の既定値（px）。</summary>
        public const double DEFAULT_RIGHT = 80;
        /// <summary>余白の最小値（px）。</summary>
        private const double MIN_MARGIN = 0;
        /// <summary>余白の最大値（px）。</summary>
        private const double MAX_MARGIN = 300;

        /// <summary>OK を押した時の、上の余白（px）。</summary>
        public double MarginTop { get; private set; }
        /// <summary>OK を押した時の、下の余白（px）。</summary>
        public double MarginBottom { get; private set; }
        /// <summary>OK を押した時の、左の余白（px）。</summary>
        public double MarginLeft { get; private set; }
        /// <summary>OK を押した時の、右の余白（px）。</summary>
        public double MarginRight { get; private set; }

        /// <summary>ダイアログを作る（今の値を表示し、上の余白の欄を選択した状態にする）。</summary>
        /// <param name="a_top">上の余白（px）。</param>
        /// <param name="a_bottom">下の余白（px）。</param>
        /// <param name="a_left">左の余白（px）。</param>
        /// <param name="a_right">右の余白（px）。</param>
        public PdfMarginDialog(double a_top, double a_bottom, double a_left, double a_right)
        {
            InitializeComponent();
            SetValues(a_top, a_bottom, a_left, a_right);
            Loaded += (s, e) =>
            {
                m_topBox.Focus();
                m_topBox.SelectAll();
            };
        }

        /// <summary>入力欄に値を表示する。</summary>
        private void SetValues(double a_top, double a_bottom, double a_left, double a_right)
        {
            m_topBox.Text = a_top.ToString("0", CultureInfo.InvariantCulture);
            m_bottomBox.Text = a_bottom.ToString("0", CultureInfo.InvariantCulture);
            m_leftBox.Text = a_left.ToString("0", CultureInfo.InvariantCulture);
            m_rightBox.Text = a_right.ToString("0", CultureInfo.InvariantCulture);
        }

        /// <summary>入力された余白を数にする（数字でなければ既定値。範囲の外なら範囲の端にする）。</summary>
        /// <param name="a_text">入力された文字。</param>
        /// <param name="a_defaultValue">既定値。</param>
        /// <returns>余白（px）。</returns>
        private static double ParseMargin(string a_text, double a_defaultValue)
        {
            if (!double.TryParse(a_text, NumberStyles.Float, CultureInfo.InvariantCulture, out double value))
            {
                value = a_defaultValue;
            }
            return Math.Max(MIN_MARGIN, Math.Min(MAX_MARGIN, value));
        }

        /// <summary>OK：入力された値を確定して閉じる。</summary>
        private void OkClick(object a_sender, RoutedEventArgs a_args)
        {
            MarginTop = ParseMargin(m_topBox.Text, DEFAULT_TOP);
            MarginBottom = ParseMargin(m_bottomBox.Text, DEFAULT_BOTTOM);
            MarginLeft = ParseMargin(m_leftBox.Text, DEFAULT_LEFT);
            MarginRight = ParseMargin(m_rightBox.Text, DEFAULT_RIGHT);
            DialogResult = true;
        }

        /// <summary>既定値に戻す（入力欄に既定値を表示するだけ。確定は OK）。</summary>
        private void ResetClick(object a_sender, RoutedEventArgs a_args)
        {
            SetValues(DEFAULT_TOP, DEFAULT_BOTTOM, DEFAULT_LEFT, DEFAULT_RIGHT);
        }
    }
}
