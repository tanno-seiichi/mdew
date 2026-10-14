using System;
using System.Reflection;
using System.Windows;

namespace mdew.dialog
{
    /// <summary>
    /// AboutWindow.xaml の相互作用ロジック
    /// </summary>
    public partial class AboutWindow : Window
    {
        public AboutWindow()
        {
            InitializeComponent();

            Assembly asm = Assembly.GetExecutingAssembly();
            this.Title = asm.GetCustomAttribute<AssemblyTitleAttribute>()?.Title ?? asm.GetName().Name;
            this.m_appTitle.Content = this.Title;
            this.m_appVersion.Content = asm.GetName().Version?.ToString() ?? string.Empty;
            this.m_appCopyright.Content = asm.GetCustomAttribute<AssemblyCopyrightAttribute>()?.Copyright ?? string.Empty;
        }
    }
}
