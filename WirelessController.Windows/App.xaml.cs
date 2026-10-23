using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace WirelessController.Windows;

public partial class App : Application
{
    public static string CrashLogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "V_Control", "crash.log");

    public App()
    {
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += OnDomainUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
    }

    public static void WriteDiagnostic(string source, Exception exception)
    {
        try
        {
            var folder = Path.GetDirectoryName(CrashLogPath)!;
            Directory.CreateDirectory(folder);
            File.AppendAllText(CrashLogPath,
                $"[{DateTimeOffset.Now:O}] {source}\r\n{exception}\r\n{new string('-', 72)}\r\n");
        }
        catch
        {
            // Crash logging must never cause a second exception.
        }
    }

    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        WriteDiagnostic("WPF dispatcher exception", e.Exception);
        e.Handled = true;
        MessageBox.Show(
            $"V_Control caught an unexpected UI error and wrote its details to:\n{CrashLogPath}\n\nError: {e.Exception.Message}\n\nIf the screen is not responding, close and reopen the application.",
            "V_Control - UI error", MessageBoxButton.OK, MessageBoxImage.Error);
    }

    private static void OnDomainUnhandledException(object? sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception exception)
            WriteDiagnostic($"AppDomain unhandled exception (terminating={e.IsTerminating})", exception);
        else
            try { File.AppendAllText(CrashLogPath, $"[{DateTimeOffset.Now:O}] Unhandled non-Exception object: {e.ExceptionObject}\r\n"); } catch { }
    }

    private static void OnUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        WriteDiagnostic("Unobserved task exception", e.Exception);
        e.SetObserved();
    }
}
