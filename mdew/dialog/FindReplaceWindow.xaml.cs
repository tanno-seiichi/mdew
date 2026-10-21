using System;
using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;

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
                Show();
            }
            if (!string.IsNullOrEmpty(a_selectedText))
            {
                m_searchBox.Text = UseRegex ? System.Text.RegularExpressions.Regex.Escape(a_selectedText) : a_selectedText;
            }
            Activate();
            m_searchBox.Focus();
            m_searchBox.SelectAll();
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
