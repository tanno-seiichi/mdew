using System;
using System.IO;
using System.Text.Json;

namespace mdew
{
    /// <summary>
    /// 次回起動時に引き継ぐ設定。%LOCALAPPDATA%\&lt;アセンブリ名&gt;\settings.json に JSON で保存する。
    /// 今後、表示倍率・行間・最近使ったファイルなどもここに追加していく。
    /// </summary>
    public class AppSettings
    {
        /// <summary>通常表示（最大化していない状態）でのウィンドウの位置とサイズ。
        /// Win32 の WINDOWPLACEMENT と同じ「作業領域座標・物理ピクセル」の値。
        /// 未保存（初回起動）なら null。</summary>
        public WindowBounds Window { get; set; }

        /// <summary>終了時に最大化していたか。</summary>
        public bool IsMaximized { get; set; }

        /// <summary>PDF に書き出す時の上の余白（px。1px = 1/96 インチ。メニュー「PDFの余白を設定…」。既定値は mde と同じ）。</summary>
        public double PdfMarginTop { get; set; } = dialog.PdfMarginDialog.DEFAULT_TOP;
        /// <summary>PDF に書き出す時の下の余白（px）。</summary>
        public double PdfMarginBottom { get; set; } = dialog.PdfMarginDialog.DEFAULT_BOTTOM;
        /// <summary>PDF に書き出す時の左の余白（px）。</summary>
        public double PdfMarginLeft { get; set; } = dialog.PdfMarginDialog.DEFAULT_LEFT;
        /// <summary>PDF に書き出す時の右の余白（px）。</summary>
        public double PdfMarginRight { get; set; } = dialog.PdfMarginDialog.DEFAULT_RIGHT;

        /// <summary>最近使ったファイル（フルパス。先頭が最新。メニュー「ファイル」→「最近使ったファイル」）。</summary>
        public System.Collections.Generic.List<string> RecentFiles { get; set; } = new System.Collections.Generic.List<string>();

        /// <summary>設定ファイルのパス。</summary>
        private static readonly string s_path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Program.AssemblyName, "settings.json");

        /// <summary>設定ファイルを人が読みやすい形（字下げ付き）で書くための設定。</summary>
        private static readonly JsonSerializerOptions s_jsonOptions = new JsonSerializerOptions { WriteIndented = true };

        /// <summary>設定を読み込む。ファイルが無い・壊れている場合は既定値を返す。</summary>
        /// <returns>読み込んだ設定（読めなければ既定値の設定）。</returns>
        public static AppSettings Load()
        {
            try
            {
                if (File.Exists(s_path))
                {
                    var settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(s_path)) ?? new AppSettings();
                    settings.RecentFiles ??= new System.Collections.Generic.List<string>();
                    return settings;
                }
            }
            catch (Exception)
            {
                // 壊れた設定ファイルは無視して既定値で起動する（次回終了時に上書きされる）
            }
            return new AppSettings();
        }

        /// <summary>設定を保存する。書き込み途中で終了しても設定ファイルが壊れないよう、
        /// 一時ファイルに書いてから置き換える。保存に失敗しても終了は妨げない。</summary>
        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(s_path));
                string temp = s_path + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(this, s_jsonOptions));
                File.Move(temp, s_path, true);
            }
            catch (Exception)
            {
                // 設定が保存できなくても致命的ではない
            }
        }
    }

    /// <summary>ウィンドウの位置とサイズ（物理ピクセル）。</summary>
    public class WindowBounds
    {
        /// <summary>左端。</summary>
        public int Left { get; set; }
        /// <summary>上端。</summary>
        public int Top { get; set; }
        /// <summary>右端（ウィンドウに含まない、1 つ右の位置）。</summary>
        public int Right { get; set; }
        /// <summary>下端（ウィンドウに含まない、1 つ下の位置）。</summary>
        public int Bottom { get; set; }
    }
}
