// VM-only native regression harness; compile alongside Kiosk.cs with /main:HAView.LifecycleTests.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
namespace HAView {
internal static class LifecycleTests {
    static void Assert(bool ok, string message) { if (!ok) throw new Exception(message); }
    public static int Main(string[] args) {
        try {
            Assert(args.Length >= 1, "Expected boot-pause, watchdog, recovery-setup, or <fixture-root> [watchdog]");
            var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
            if (args[0] == "boot-pause") {
                string fixture = Path.Combine(Path.GetTempPath(), "HA.View-Pause-Test-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(fixture);
                typeof(Kiosk).GetField("Root", flags).SetValue(null, fixture);
                try {
                    string boot = Native.BootIdentity();
                    Assert(boot == Native.BootIdentity(), "boot identity unstable without reboot");
                    Assert(!Kiosk.PausedForBoot(boot), "new fixture paused");
                    Kiosk.PauseForBoot(boot);
                    string record = Path.Combine(fixture, "boot-pause", "pause.json");
                    var user = System.Security.Principal.WindowsIdentity.GetCurrent().User;
                    Assert(Directory.GetAccessControl(Path.GetDirectoryName(record)).GetOwner(typeof(System.Security.Principal.SecurityIdentifier)).Equals(user), "pause directory owner differs from token user");
                    Assert(File.GetAccessControl(record).GetOwner(typeof(System.Security.Principal.SecurityIdentifier)).Equals(user), "atomic pause file owner differs from token user");
                    Kiosk.PauseForBoot(boot); // Exercise File.Replace, not just File.Move.
                    Assert(File.GetAccessControl(record).GetOwner(typeof(System.Security.Principal.SecurityIdentifier)).Equals(user), "replaced pause file owner differs from token user");
                    Assert(File.GetAccessControl(record).AreAccessRulesProtected, "pause file ACL inheritance not protected");
                    string unrelated = Path.Combine(fixture, "boot-pause", "unrelated.txt"); File.WriteAllText(unrelated, "keep");
                    Assert(Kiosk.PausedForBoot(boot), "same boot did not stay paused");
                    Assert(!Kiosk.PausedForBoot(Guid.NewGuid().ToString("D")), "different boot did not resume");
                    Assert(!File.Exists(record) && File.ReadAllText(unrelated) == "keep", "cleanup touched unrelated state");
                    Kiosk.PauseForBoot(boot);
                    File.WriteAllText(record, "{}"); bool rejected = false;
                    try { Kiosk.PausedForBoot(boot); } catch (InvalidDataException) { rejected = true; }
                    Assert(rejected && File.Exists(record), "malformed record not preserved/fail-closed");
                    Console.WriteLine("PASS: boot GUID, persistent pause, reboot-only cleanup, unrelated preservation, malformed rejection");
                } finally { Directory.Delete(fixture, true); }
                return 0;
            }
            // Scheduled-task form derives the fixture root from this executable.
            if (args.Length == 1 && (args[0] == "watchdog" || args[0] == "recovery-setup")) {
                string self = Process.GetCurrentProcess().MainModule.FileName;
                string fixtureRoot = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(self)));
                typeof(Kiosk).GetField("Root", flags).SetValue(null, fixtureRoot);
                typeof(Kiosk).GetField("TaskName", flags).SetValue(null, "HA.View-Recovery-Fixture");
                Console.WriteLine("Identity: " + System.Security.Principal.WindowsIdentity.GetCurrent().Name);
                if (args[0] == "watchdog") {
                    try { typeof(Kiosk).GetMethod("Watchdog", flags).Invoke(null, null); }
                    catch (System.Reflection.TargetInvocationException e) { throw e.InnerException; }
                } else {
                    dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)); scheduler.Connect();
                    dynamic folder = scheduler.GetFolder("\\");
                    typeof(Kiosk).GetMethod("Register", flags).Invoke(null, new object[] { scheduler, folder, "fixture" });
                    dynamic task = folder.GetTask("HA.View-Recovery-Fixture");
                    typeof(Kiosk).GetMethod("Owned", flags).Invoke(null, new object[] { task });
                    // Actual COM definitions: reject security/trigger changes before restore.
                    string original = task.Xml;
                    dynamic definition = scheduler.NewTask(0); definition.XmlText = original;
                    definition.Triggers.Create(8); // boot trigger, not owned
                    bool rejected = false;
                    try { typeof(Kiosk).GetMethod("OwnedDefinition", flags).Invoke(null, new object[] { definition }); }
                    catch (System.Reflection.TargetInvocationException) { rejected = true; }
                    Assert(rejected, "foreign trigger accepted");
                    var journal = new Journal { oldActive = File.ReadAllText(Path.Combine(fixtureRoot, "active.json")), oldTask = original, oldEnabled = false, oldRunning = false };
                    typeof(Kiosk).GetMethod("Restore", flags).Invoke(null, new object[] { folder, journal });
                    task = folder.GetTask("HA.View-Recovery-Fixture");
                    Assert((int)task.Definition.Triggers.Count == 2 && (string)task.Definition.Triggers.Item(2).Repetition.Interval == "PT1M" && !(bool)task.Enabled, "rollback lost recovery trigger/enabled state");
                    Console.WriteLine("PASS: foreign trigger rejected; rollback preserved periodic trigger and disabled state.");
                    task.Enabled = true; // First launch and recovery MUST come from clock, never Run.
                    Console.WriteLine("Registered production definition; waiting for clock trigger.");
                }
                return 0;
            }
            // Standalone WatchdogLifecycleTests.ps1 passes <root> watchdog.
            Assert(args.Length == 1 || (args.Length == 2 && args[1] == "watchdog"), "Invalid lifecycle harness arguments");
            string root = Path.GetFullPath(args[0]);
            if (args.Length == 2 && args[1] == "watchdog") {
                // Isolate test state from the installed user's kiosk/task/profile.
                typeof(Kiosk).GetField("Root", flags).SetValue(null, root);
                typeof(Kiosk).GetField("Self", flags).SetValue(null, Path.Combine(root, "versions", "fixture", "HA.View.Kiosk.exe"));
                try { typeof(Kiosk).GetMethod("Watchdog", flags).Invoke(null, null); }
                catch (System.Reflection.TargetInvocationException e) { throw e.InnerException; }
                return 0;
            }
            using (var unrelated = Process.Start(Path.Combine(root, "established", "child.exe"))) {
                try {
                    for (int i = 0; i < 3; i++) using (var child = Native.Launch(Path.Combine(root, "early", "child.exe"))) {
                        Assert(child.WaitForExit(5000), "early exit timeout"); Assert(child.ExitCode == 37, "early exit code");
                    }
                    Console.WriteLine("PASS: three actual early exits, code 37");
                    using (var child = Native.Launch(Path.Combine(root, "code259", "child.exe"))) {
                        Assert(child.WaitForExit(5000), "259 exit timeout"); Assert(child.ExitCode == 259, "legal STILL_ACTIVE exit code");
                    }
                    Console.WriteLine("PASS: signaled process with exit code 259");
                    for (int i = 0; i < 2; i++) using (var child = Native.Launch(Path.Combine(root, "established", "child.exe"))) {
                        Assert(!child.WaitForExit(5000), "established child exited early");
                        using (var p = Process.GetProcessById(child.Id)) {
                            Assert(p.StartTime.ToUniversalTime() == child.CreatedUtc, "creation identity"); p.Kill();
                        }
                        Assert(child.WaitForExit(5000), "crash wait timeout"); Console.WriteLine("PASS: established crash/relaunch " + i + ", exit " + child.ExitCode);
                    }
                    int owned;
                    var closing = Native.Launch(Path.Combine(root, "established", "child.exe"));
                    owned = closing.Id;
                    using (var p = Process.GetProcessById(owned)) { closing.Dispose(); closing.Dispose(); Assert(p.WaitForExit(5000), "job close did not kill owned child"); }
                    Assert(!unrelated.HasExited, "unrelated process killed");
                    Console.WriteLine("PASS: job-close ownership, idempotent dispose, unrelated same-name child preserved");
                } finally { if (!unrelated.HasExited) unrelated.Kill(); unrelated.WaitForExit(); }
            }
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
}
