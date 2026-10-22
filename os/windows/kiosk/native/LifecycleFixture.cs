// VM test payload only; never ship in a kiosk distribution.
using System;
using System.IO;
using System.Reflection;
using System.Threading;
internal static class LifecycleFixture {
    public static int Main() {
        string mode = Path.GetFileName(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
        string marker = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "mode.txt");
        if (File.Exists(marker)) mode = File.ReadAllText(marker).Trim();
        if (mode == "pause") return 42;
        if (mode == "pause-established") { Thread.Sleep(6000); return 42; }
        if (mode == "early") return 37;
        if (mode == "code259") return 259;
        if (mode == "persistent") Thread.Sleep(Timeout.Infinite);
        Thread.Sleep(60000); return 0;
    }
}
