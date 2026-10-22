// HA.View native Windows kiosk host. Build on the project VM, never on clients.
// .NET Framework 4.x / C# 5; no PowerShell, Node, shell command evaluation or elevation.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography.Pkcs;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace HAView {
public sealed class Entry { public string path; public long size; public string sha256; }
public sealed class Manifest { public int schema; public string platform, arch, version, executable, signing; public Entry[] files; }
public sealed class Active { public int schema = 1; public string version, publisher, publisherProfileEku; public bool allowUnsigned; }
// Operator-controlled identity only; never infer a policy from an untrusted bundle.
internal sealed class PublisherPolicy {
    internal const string CodeSigning = "1.3.6.1.5.5.7.3.3";
    internal readonly string Thumbprint, ProfileEku;
    PublisherPolicy(string thumbprint, string profileEku) { Thumbprint = thumbprint; ProfileEku = profileEku; }
    internal static PublisherPolicy Parse(bool development, string thumbprint, string profileEku) {
        // Empty, whitespace and ambiguous supplied inputs are errors, including development.
        if (thumbprint != null && profileEku != null) throw new InvalidDataException("Publisher trust inputs are mutually exclusive");
        if (thumbprint != null && !Regex.IsMatch(thumbprint, @"\A[a-fA-F0-9]{40}\z")) throw new InvalidDataException("Invalid publisher thumbprint");
        if (profileEku != null && !ValidProfileOid(profileEku)) throw new InvalidDataException("Invalid Artifact Signing profile EKU");
        if (!development && thumbprint == null && profileEku == null) throw new InvalidDataException("Signed mode requires independent HA_VIEW_PUBLISHER_THUMBPRINT or HA_VIEW_PUBLISHER_PROFILE_EKU; never from the bundle");
        return new PublisherPolicy(thumbprint, profileEku);
    }
    internal static bool ValidProfileOid(string value) {
        // Exact independently approved Public Trust profile identity only. The .97.1
        // branch is reserved for service/type and Private Trust identities; reject
        // that entire branch, not just known examples. No sample-derived arity.
        const string prefix = "1.3.6.1.4.1.311.97.";
        if (value == null || value.Length > 512 || !value.StartsWith(prefix, StringComparison.Ordinal)) return false;
        string[] arcs = value.Substring(prefix.Length).Split('.');
        if (arcs[0] == "1") return false;
        foreach (string arc in arcs) {
            uint number;
            if (!Regex.IsMatch(arc, @"\A(?:0|[1-9][0-9]*)\z") || !UInt32.TryParse(arc, out number)) return false;
        }
        return true;
    }
    internal void Match(X509Certificate2 certificate) {
        if (certificate == null) throw new InvalidDataException("Missing signer certificate");
        if (Thumbprint != null) {
            if (!String.Equals(certificate.Thumbprint, Thumbprint, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Pinned publisher mismatch");
        } else {
            if (ProfileEku == null || !HasEku(certificate, ProfileEku)) throw new InvalidDataException("Approved profile EKU mismatch");
        }
    }
    internal static bool HasEku(X509Certificate2 certificate, string oid) {
        if (certificate == null) return false;
        var extensions = certificate.Extensions.Cast<X509Extension>().Where(e => e.Oid.Value == "2.5.29.37").ToArray();
        if (extensions.Length != 1) return false;
        var eku = new X509EnhancedKeyUsageExtension(extensions[0], extensions[0].Critical);
        return eku.EnhancedKeyUsages.Cast<Oid>().Any(o => o.Value == oid);
    }
    internal void VerifyManifestSigner(X509Certificate2 certificate, X509Certificate2Collection extra) {
        if (!HasEku(certificate, CodeSigning)) throw new InvalidDataException("Manifest signer requires explicit code-signing EKU");
        using (var chain = new X509Chain()) {
            chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
            chain.ChainPolicy.RevocationFlag = X509RevocationFlag.ExcludeRoot;
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid(CodeSigning));
            chain.ChainPolicy.ExtraStore.AddRange(extra);
            // Current-time validation deliberately does not interpret RFC3161 timestamps.
            if (!chain.Build(certificate)) throw new System.Security.SecurityException("Manifest signer chain/revocation failed");
        }
        Match(certificate); // identity is checked only after successful trust validation
    }
}
public sealed class BootPauseRecord { public int schema = 1; public string sid, boot; }
public sealed class Started { public string version, created; public int processId; }
public sealed class Journal { public string oldActive, oldTask; public bool oldEnabled, oldRunning; }
public static class Kiosk {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ha.view-kiosk");
    static readonly string Self = Process.GetCurrentProcess().MainModule.FileName;
    static readonly string Sid = WindowsIdentity.GetCurrent().User.Value;
    static readonly string TaskName = "HA.View-Kiosk-" + Sid;
    static string LogPath;
    static void Log(string text) {
        Console.WriteLine(text);
        if (LogPath == null) { LogPath = Path.Combine(Path.GetTempPath(), "HA.View-Native-" + Guid.NewGuid().ToString("N") + ".log"); NoLinks(LogPath); Console.WriteLine("Diagnostic log: " + LogPath); }
        File.AppendAllText(LogPath, DateTime.UtcNow.ToString("o") + " " + text + Environment.NewLine);
    }
    static void Require(bool condition, string message) { if (!condition) throw new InvalidDataException(message); }
    static string Hash(string file) { NoLinks(file); using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static void NoLinks(string path) {
        for (string p = Path.GetFullPath(path); p != null; p = Path.GetDirectoryName(p)) {
            if (File.Exists(p) || Directory.Exists(p)) Require((File.GetAttributes(p) & FileAttributes.ReparsePoint) == 0, "Reparse point forbidden: " + p);
        }
    }
    static bool Safe(string name) {
        return name != null && name.Length < 240 && !Regex.IsMatch(name, "[\\\\:?*<>\"|\\x00-\\x1f]") &&
            name.Split('/').All(p => p.Length != 0 && p != "." && p != ".." && !Regex.IsMatch(p, "[. ]$") && !Regex.IsMatch(p, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", RegexOptions.IgnoreCase));
    }
    static string[] Files(string directory) {
        NoLinks(directory);
        var result = new List<string>();
        foreach (string p in Directory.GetFileSystemEntries(directory)) { NoLinks(p); if (Directory.Exists(p)) result.AddRange(Files(p)); else result.Add(p); }
        return result.ToArray();
    }
    static T Read<T>(string path) { NoLinks(path); Require(new FileInfo(path).Length <= 16777216, "Oversized JSON"); return Json.Deserialize<T>(File.ReadAllText(path)); }
    static void Atomic(string path, string text, FileSecurity security = null) {
        NoLinks(path); string next = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var f = security == null
            ? new FileStream(next, FileMode.CreateNew, FileAccess.Write, FileShare.None)
            : new FileStream(next, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.None, security)) { byte[] data = Encoding.UTF8.GetBytes(text); f.Write(data, 0, data.Length); f.Flush(true); }
        if (File.Exists(path)) File.Replace(next, path, null); else File.Move(next, path);
    }
    static string PauseDirectory() {
        string path = Path.Combine(Root, "boot-pause"); NoLinks(path);
        var user = new SecurityIdentifier(Sid);
        if (!Directory.Exists(path)) {
            var acl = new DirectorySecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.CreateDirectory(path, acl);
        }
        NoLinks(path);
        var security = Directory.GetAccessControl(path);
        Require(security.GetOwner(typeof(SecurityIdentifier)).Equals(user) && security.AreAccessRulesProtected, "Unsafe kiosk pause directory owner/ACL");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            Require(rule.AccessControlType != AccessControlType.Allow || rule.IdentityReference.Equals(user), "Foreign kiosk pause directory access");
        return path;
    }
    static BootPauseRecord ReadPause(string path) {
        NoLinks(path); if (!File.Exists(path)) return null;
        var security = File.GetAccessControl(path);
        Require(security.GetOwner(typeof(SecurityIdentifier)).Value == Sid, "Foreign kiosk pause record owner");
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            Require(rule.AccessControlType != AccessControlType.Allow || rule.IdentityReference.Value == Sid, "Foreign kiosk pause record access");
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            Native.RequireSingleLink(file);
            Require(file.Length <= 1024, "Oversized kiosk pause record");
            using (var reader = new StreamReader(file)) {
                var record = Json.Deserialize<BootPauseRecord>(reader.ReadToEnd()); Guid parsed;
                Require(record != null && record.schema == 1 && record.sid == Sid && Guid.TryParseExact(record.boot, "D", out parsed), "Invalid kiosk pause record");
                return record;
            }
        }
    }
    internal static bool PausedForBoot(string boot) {
        string path = Path.Combine(PauseDirectory(), "pause.json");
        var record = ReadPause(path); if (record == null) return false;
        if (String.Equals(record.boot, boot, StringComparison.OrdinalIgnoreCase)) return true;
        // Only our validated pause record is retired, never directory contents.
        NoLinks(path); File.Delete(path); return false;
    }
    internal static void PauseForBoot(string boot) {
        Guid parsed; Require(Guid.TryParseExact(boot, "D", out parsed), "Invalid OS boot identity");
        string path = Path.Combine(PauseDirectory(), "pause.json"); ReadPause(path);
        // Elevated tokens may default file ownership to Administrators. Supply
        // the owner at CreateNew, before any bytes or the atomic rename are visible.
        var user = new SecurityIdentifier(Sid);
        var security = new FileSecurity(); security.SetOwner(user); security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
        Atomic(path, Json.Serialize(new BootPauseRecord { sid = Sid, boot = boot }), security);
    }
    static FileStream Lock(string name) { string p = Path.Combine(Root, name); NoLinks(p); return new FileStream(p, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
    static string VersionPath(string version) { Require(Safe(version) && version.IndexOf('/') < 0 && Regex.IsMatch(version, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"), "Invalid active version"); return Path.Combine(Root, "versions", version); }
    static Active GetActive() { var a = Read<Active>(Path.Combine(Root, "active.json")); Require(a != null && a.schema == 1, "Invalid active config"); VersionPath(a.version); PublisherPolicy.Parse(a.allowUnsigned, a.publisher, a.publisherProfileEku); return a; }
    static void Trust(string path, bool development, PublisherPolicy policy) {
        NoLinks(path); if (development) return;
        Native.VerifyTrust(path);
        using (var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path))) policy.Match(cert);
    }
    static Manifest Validate(string directory, bool development, PublisherPolicy policy) {
        NoLinks(directory); var m = Read<Manifest>(Path.Combine(directory, "manifest.json"));
        Require(m != null && m.schema == 1 && m.platform == "win32" && m.arch == "x64" && m.executable == "payload/ha.view.exe" && Regex.IsMatch(m.version ?? "", @"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") && (m.signing == "unsigned-development" || m.signing == "signed-input-unverified") && m.files != null, "Invalid manifest identity");
        Require(development || m.signing == "signed-input-unverified", "Unsigned bundle requires explicit Development launcher");
        var names = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in m.files) { Require(e != null && Safe(e.path) && (e.path.StartsWith("payload/", StringComparison.Ordinal) || new [] { "HA.View.Kiosk.exe", "README.md", "Setup.cmd", "Update.cmd", "Setup-Development.cmd", "Update-Development.cmd" }.Contains(e.path)) && e.size >= 0 && Regex.IsMatch(e.sha256 ?? "", "^[a-f0-9]{64}$") && !names.ContainsKey(e.path), "Invalid/duplicate manifest entry"); names.Add(e.path, e); }
        if (!development) {
            string signature = Path.Combine(directory, "manifest.p7s"); NoLinks(signature);
            var cms = new SignedCms(new ContentInfo(File.ReadAllBytes(Path.Combine(directory, "manifest.json"))), true);
            cms.Decode(File.ReadAllBytes(signature)); cms.CheckSignature(false);
            Require(cms.SignerInfos.Count == 1 && cms.SignerInfos[0].Certificate != null, "Manifest requires exactly one certificate signer");
            policy.VerifyManifestSigner(cms.SignerInfos[0].Certificate, cms.Certificates);
        }
        foreach (string p in Files(directory)) {
            string relative = p.Substring(directory.TrimEnd(Path.DirectorySeparatorChar).Length + 1).Replace('\\', '/'); if (relative == "manifest.json" || (!development && relative == "manifest.p7s")) continue;
            Entry e; Require(names.TryGetValue(relative, out e) && e.path == relative, "Unlisted/alternate-case file: " + relative);
            Require(new FileInfo(p).Length == e.size && Hash(p) == e.sha256, "Checksum mismatch: " + relative); names.Remove(relative);
        }
        Require(names.Count == 0, "Manifest files missing from extraction");
        foreach (string required in new [] { "HA.View.Kiosk.exe", "README.md", "Setup.cmd", "Update.cmd", "Setup-Development.cmd", "Update-Development.cmd", "payload/ha.view.exe", "payload/resources/app/package.json", "payload/resources/app/index.js" }) Require(m.files.Any(e => e.path == required), "Missing package component: " + required);
        var app = Read<Dictionary<string, object>>(Path.Combine(directory, "payload", "resources", "app", "package.json"));
        Require(app.ContainsKey("name") && (string)app["name"] == "ha.view" && app.ContainsKey("version") && (string)app["version"] == m.version && app.ContainsKey("main") && (string)app["main"] == "index.js", "Packaged app identity mismatch");
        Trust(Path.Combine(directory, "HA.View.Kiosk.exe"), development, policy);
        Trust(Path.Combine(directory, "payload", "ha.view.exe"), development, policy);
        return m;
    }
    static dynamic Scheduler() { var s = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true)); ((dynamic)s).Connect(); return s; }
    static dynamic FindTask(dynamic folder) { foreach (dynamic t in folder.GetTasks(1)) if ((string)t.Name == TaskName) return t; return null; }
    static string UserSid(string user) { return user.StartsWith("S-1-", StringComparison.Ordinal) ? user : ((SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier))).Value; }
    static void Owned(dynamic task) {
        if (task == null) return;
        OwnedDefinition(task.Definition);
    }
    static void OwnedDefinition(dynamic def) {
        Require(UserSid((string)def.Principal.UserId) == Sid && (int)def.Principal.LogonType == 3 && (int)def.Principal.RunLevel == 0 && (int)def.Actions.Count == 1, "Refusing unrelated task principal/action");
        Require((int)def.Settings.MultipleInstances == 2, "Refusing task without IgnoreNew ownership guard");
        // Accept the legacy logon-only definition for update/rollback, or our exact
        // logon + periodic recovery shape. Never accept boot/other-user triggers.
        Require((int)def.Triggers.Count == 1 || (int)def.Triggers.Count == 2, "Refusing unrelated task triggers");
        int logon = 0, recovery = 0;
        foreach (dynamic trigger in def.Triggers) {
            Require((bool)trigger.Enabled && String.IsNullOrEmpty((string)trigger.EndBoundary), "Refusing disabled/expiring task trigger");
            if ((int)trigger.Type == 9) {
                Require(UserSid((string)trigger.UserId) == Sid && String.IsNullOrEmpty((string)trigger.Repetition.Interval), "Refusing unrelated logon trigger"); logon++;
            } else {
                Require((int)trigger.Type == 1 && !String.IsNullOrEmpty((string)trigger.StartBoundary) &&
                    (string)trigger.Repetition.Interval == "PT1M" && String.IsNullOrEmpty((string)trigger.Repetition.Duration) &&
                    !(bool)trigger.Repetition.StopAtDurationEnd, "Refusing unrelated recovery trigger"); recovery++;
            }
        }
        Require(logon == 1 && recovery == (int)def.Triggers.Count - 1, "Refusing duplicate task triggers");
        dynamic action = def.Actions.Item(1); string p = (string)action.Path;
        NoLinks(p); Require(p.StartsWith(Path.Combine(Root, "versions") + "\\", StringComparison.OrdinalIgnoreCase) && Path.GetFileName(p) == "HA.View.Kiosk.exe" && (string)action.Arguments == "watchdog", "Refusing unrelated scheduled task");
    }
    static void Quiesce(dynamic folder) {
        dynamic t = FindTask(folder); Owned(t);
        if (t != null) { t.Enabled = false; t.Stop(0); }
        // Task termination closes the watchdog's job handle: only its own descendants die.
        for (int i = 0; i < 100; i++) { try { using (Lock("watchdog.lock")) return; } catch (IOException) { Thread.Sleep(100); } }
        throw new IOException("Owned watchdog did not stop; no process-name/PID force kill attempted");
    }
    static void Register(dynamic scheduler, dynamic folder, string version) {
        dynamic d = scheduler.NewTask(0);
        d.RegistrationInfo.Description = "HA.View per-user native kiosk watchdog";
        d.Principal.UserId = Sid; d.Principal.LogonType = 3; d.Principal.RunLevel = 0;
        dynamic trigger = d.Triggers.Create(9); trigger.UserId = Sid;
        // Forced termination may not activate RestartOnFailure. An independent
        // clock retries this SAME IgnoreNew task; InteractiveToken still requires
        // this user's existing login (no boot login, password or autologon change).
        dynamic recovery = d.Triggers.Create(1);
        recovery.StartBoundary = DateTime.UtcNow.AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:ssZ");
        recovery.Repetition.Interval = "PT1M"; recovery.Repetition.StopAtDurationEnd = false;
        dynamic action = d.Actions.Create(0); action.Path = Path.Combine(VersionPath(version), "HA.View.Kiosk.exe"); action.Arguments = "watchdog"; action.WorkingDirectory = Root;
        d.Settings.Enabled = false; d.Settings.MultipleInstances = 2; d.Settings.ExecutionTimeLimit = "PT0S";
        d.Settings.DisallowStartIfOnBatteries = false; d.Settings.StopIfGoingOnBatteries = false;
        d.Settings.RestartCount = 999; d.Settings.RestartInterval = "PT1M";
        OwnedDefinition(d);
        folder.RegisterTaskDefinition(TaskName, d, 6, Sid, null, 3, null);
    }
    static void Restore(dynamic folder, Journal j) {
        // Validate journal XML before changing task/config, including its triggers.
        if (j.oldTask != null) { dynamic prior = Scheduler().NewTask(0); prior.XmlText = j.oldTask; OwnedDefinition(prior); }
        Quiesce(folder);
        string active = Path.Combine(Root, "active.json");
        if (j.oldActive == null) { NoLinks(active); if (File.Exists(active)) File.Delete(active); } else Atomic(active, j.oldActive);
        if (j.oldTask == null) { if (FindTask(folder) != null) folder.DeleteTask(TaskName, 0); }
        else { dynamic t = folder.RegisterTask(TaskName, j.oldTask, 6, Sid, null, 3, null); Owned(t); t.Enabled = j.oldEnabled; if (j.oldEnabled && j.oldRunning) t.Run(null); }
        Log("Rollback restored previous active config/task; versions and APPDATA settings retained.");
    }
    static void Recover(dynamic folder) {
        string p = Path.Combine(Root, "transaction.json"); NoLinks(p);
        if (File.Exists(p)) { Log("Recovering interrupted transaction"); Restore(folder, Read<Journal>(p)); File.Delete(p); }
    }
    static void Install(bool development, bool update) {
        Require(Environment.Is64BitOperatingSystem && Environment.Is64BitProcess, "Windows x64 required");
        string source = Path.GetDirectoryName(Self);
        var policy = PublisherPolicy.Parse(development, Environment.GetEnvironmentVariable("HA_VIEW_PUBLISHER_THUMBPRINT"), Environment.GetEnvironmentVariable("HA_VIEW_PUBLISHER_PROFILE_EKU"));
        Log(development ? "EXPLICIT DEVELOPMENT: accepting unsigned native/app code; not signed acceptance." : "Strict signed mode; Windows trust and independent publisher pin required.");
        Log("Validating complete source extraction...");
        var m = Validate(source, development, policy); // complete extraction, no Bundle/Sha256 prompts
        Require(Hash(Self) == Hash(Path.Combine(source, "HA.View.Kiosk.exe")), "Executing host mismatch");
        NoLinks(Root); Directory.CreateDirectory(Root);
        using (Lock("installer.lock")) {
            dynamic s = Scheduler(), folder = s.GetFolder("\\"); Recover(folder);
            string active = Path.Combine(Root, "active.json"); NoLinks(active);
            Require(!update || File.Exists(active), "Update requires an existing installation");
            string version = m.version + "-" + Guid.NewGuid().ToString("N"); string destination = VersionPath(version);
            string stage = Path.Combine(Root, "stage-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage);
            try {
                foreach (var e in m.files) { string target = Path.Combine(stage, e.path.Replace('/', '\\')); Directory.CreateDirectory(Path.GetDirectoryName(target)); File.Copy(Path.Combine(source, e.path.Replace('/', '\\')), target); Require(Hash(target) == e.sha256, "Copied file checksum mismatch"); }
                File.Copy(Path.Combine(source, "manifest.json"), Path.Combine(stage, "manifest.json")); if (!development) File.Copy(Path.Combine(source, "manifest.p7s"), Path.Combine(stage, "manifest.p7s")); Validate(stage, development, policy);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)); NoLinks(destination); Directory.Move(stage, destination);
                dynamic old = FindTask(folder); Owned(old);
                var j = new Journal { oldActive = File.Exists(active) ? File.ReadAllText(active) : null, oldTask = old == null ? null : (string)old.Xml, oldEnabled = old != null && (bool)old.Enabled, oldRunning = old != null && (int)old.State == 4 };
                string journal = Path.Combine(Root, "transaction.json"); Atomic(journal, Json.Serialize(j));
                try {
                    Quiesce(folder); Register(s, folder, version);
                    Atomic(active, Json.Serialize(new Active { version = version, allowUnsigned = development, publisher = policy.Thumbprint, publisherProfileEku = policy.ProfileEku }));
                    dynamic t = FindTask(folder); t.Enabled = true; t.Run(null);
                    bool healthy = false; string started = Path.Combine(destination, "started.json");
                    for (int i = 0; i < 180; i++) {
                        Thread.Sleep(1000); if (!File.Exists(started)) continue;
                        var record = Read<Started>(started); Require(record.version == version, "Stale startup record");
                        try { using (var p = Process.GetProcessById(record.processId)) { healthy = !p.HasExited && p.MainModule.FileName.Equals(Path.Combine(destination, "payload", "ha.view.exe"), StringComparison.OrdinalIgnoreCase) && p.StartTime.ToUniversalTime().ToString("o") == record.created && (int)t.State == 4; } } catch (ArgumentException) { }
                        if (healthy) { Log("Launch verified: owned child PID " + record.processId + "; rendering NOT verified."); break; }
                    }
                    Require(healthy, "No stable owned app child in 180 seconds (includes full on-disk validation). Check watchdog logs/profile owner; unrelated apps are never stopped.");
                    NoLinks(journal); File.Delete(journal); Log("Install committed. APPDATA profile untouched. Task: " + TaskName);
                } catch { Restore(folder, j); File.Delete(journal); throw; }
            } finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
        }
    }
    static void Watchdog() {
        NoLinks(Root); using (Lock("watchdog.lock")) {
            // A forced death cannot execute finally. Withdraw its claim as soon as
            // a fresh exclusive owner starts, even if active config/validation fails.
            string selfDirectory = Path.GetDirectoryName(Self);
            Require(selfDirectory.Equals(VersionPath(Path.GetFileName(selfDirectory)), StringComparison.OrdinalIgnoreCase), "Watchdog outside owned version");
            string stale = Path.Combine(selfDirectory, "started.json"); NoLinks(stale); if (File.Exists(stale)) File.Delete(stale);
            string boot = Native.BootIdentity();
            if (PausedForBoot(boot)) { Log("Kiosk paused until OS restart"); return; }
            int early = 0;
            while (true) {
                var a = GetActive(); string directory = VersionPath(a.version);
                Require(Path.GetDirectoryName(Self).Equals(directory, StringComparison.OrdinalIgnoreCase), "Active version does not match task");
                string started = Path.Combine(directory, "started.json"); NoLinks(started); if (File.Exists(started)) File.Delete(started);
                Log("Watchdog validating installed payload before launch...");
                Validate(directory, a.allowUnsigned, PublisherPolicy.Parse(a.allowUnsigned, a.publisher, a.publisherProfileEku));
                try {
                    using (var child = Native.Launch(Path.Combine(directory, "payload", "ha.view.exe"))) {
                        bool exitedEarly = child.WaitForExit(5000);
                        if (exitedEarly && child.ExitCode == 42) { PauseForBoot(boot); Log("Kiosk paused until OS restart"); return; }
                        if (exitedEarly) { Log("Owned child exited early: " + child.ExitCode); Require(++early < 3, "Three early exits; watchdog failed; Task Scheduler will retry"); }
                        else {
                            Atomic(started, Json.Serialize(new Started { version = a.version, processId = child.Id, created = child.CreatedUtc.ToString("o") }));
                            Log("Owned child survived five seconds; rendering NOT verified."); early = 0; child.WaitForExit(UInt32.MaxValue);
                            if (child.ExitCode == 42) { PauseForBoot(boot); Log("Kiosk paused until OS restart"); return; }
                            Log("Owned child exited: " + child.ExitCode + "; restarting");
                        }
                    }
                } finally {
                    // Also clear the health claim on early-exit threshold or native API failure.
                    NoLinks(started); if (File.Exists(started)) File.Delete(started);
                }
                Thread.Sleep(5000);
            }
        }
    }
    public static int Main(string[] args) {
        try {
            Require(args.Length == 1, "Use Setup.cmd / Update.cmd (or explicit Development launcher) from the complete extracted distribution.");
            switch (args[0]) {
                case "setup": Install(false, false); break;
                case "update": Install(false, true); break;
                case "setup-development": Install(true, false); break;
                case "update-development": Install(true, true); break;
                case "watchdog": Watchdog(); break;
                case "self-test": Require(Safe("payload/a.txt") && !Safe("../x") && !Safe("CON.txt") && !Safe("a\\b"), "Path tests"); Log("Native self-test passed; Windows API integration NOT tested."); break;
                default: throw new ArgumentException("Unknown fixed operation");
            }
            return 0;
        } catch (Exception e) { try { Log("FAILED: " + e); } catch { Console.Error.WriteLine(e); } return 1; }
    }
}
internal static class Native {
    // Kernel boot GUID, not session ID, uptime arithmetic, or logon time.
    [StructLayout(LayoutKind.Sequential)] struct BootEnvironment { public Guid boot; public uint firmware; public ulong flags; }
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, ref BootEnvironment value, int size, out int returned);
    internal static string BootIdentity() {
        var value = new BootEnvironment(); int returned;
        int status = NtQuerySystemInformation(90, ref value, Marshal.SizeOf(value), out returned);
        if (status < 0 || returned < 16 || value.boot == Guid.Empty) throw new InvalidOperationException("Cannot read OS boot identity: " + status);
        return value.boot.ToString("D");
    }
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file, out FileInformation info);
    internal static void RequireSingleLink(FileStream file) {
        FileInformation info; Check(GetFileInformationByHandle(file.SafeFileHandle, out info));
        if (info.links != 1) throw new InvalidDataException("Hard-linked kiosk pause record");
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TrustFile { public uint size; public string path; public IntPtr file, subject; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TrustData { public uint size; public IntPtr policy, sip; public uint ui, revocation, choice; public IntPtr file; public uint action; public IntPtr state; public string url; public uint flags, context; }
    [DllImport("wintrust.dll", ExactSpelling = true)] static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    internal static void VerifyTrust(string path) {
        var f = new TrustFile { size = (uint)Marshal.SizeOf(typeof(TrustFile)), path = path };
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(f)); Marshal.StructureToPtr(f, ptr, false);
        var d = new TrustData { size = (uint)Marshal.SizeOf(typeof(TrustData)), ui = 2, revocation = 1, choice = 1, file = ptr, action = 1, flags = 0x80 };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try { int result = WinVerifyTrust(new IntPtr(-1), ref action, ref d); if (result != 0) throw new System.Security.SecurityException("Windows Authenticode trust failed: 0x" + result.ToString("X8")); }
        finally { d.action = 2; WinVerifyTrust(new IntPtr(-1), ref action, ref d); Marshal.DestroyStructure(ptr, typeof(TrustFile)); Marshal.FreeHGlobal(ptr); }
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long perProcess, perJob; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup { public uint cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show, reservedSize; public IntPtr reservedBytes,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string directory, ref Startup startup, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    internal sealed class Child : IDisposable {
        internal IntPtr Handle, Job; internal int Id; internal DateTime CreatedUtc;
        internal bool WaitForExit(uint milliseconds) {
            if (Handle == IntPtr.Zero) throw new ObjectDisposedException("Child");
            uint result = WaitForSingleObject(Handle, milliseconds);
            if (result == 0) return true;
            if (result == 0x102) return false;
            if (result == UInt32.MaxValue) Check(false);
            throw new InvalidOperationException("Unexpected process wait result: " + result);
        }
        internal uint ExitCode {
            get {
                // STILL_ACTIVE (259) is also a legal exit code: use the signaled handle.
                if (!WaitForExit(0)) throw new InvalidOperationException("Owned child is still running");
                uint code; Check(GetExitCodeProcess(Handle, out code)); return code;
            }
        }
        public void Dispose() {
            if (Job != IntPtr.Zero) { CloseHandle(Job); Job = IntPtr.Zero; }
            if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; }
        }
    }
    internal static Child Launch(string exe) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero); Info info = new Info();
        try {
            var limits = new Limits(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; non-inheritable handle
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var start = new Startup { cb = (uint)Marshal.SizeOf(typeof(Startup)) };
            Check(CreateProcess(exe, new StringBuilder("\"" + exe + "\" --app-kiosk=fullscreen"), IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, Path.GetDirectoryName(exe), ref start, out info));
            // Suspended creation prevents any unowned children before job assignment.
            Check(AssignProcessToJobObject(job, info.process));
            long created, exited, kernel, user;
            Check(GetProcessTimes(info.process, out created, out exited, out kernel, out user));
            if (ResumeThread(info.thread) == UInt32.MaxValue) Check(false);
            // Retain the creation handle, never reopen by PID (exit/PID-reuse race).
            var child = new Child { Job = job, Handle = info.process, Id = (int)info.pid, CreatedUtc = DateTime.FromFileTimeUtc(created) };
            job = IntPtr.Zero; info.process = IntPtr.Zero; return child;
        } catch { if (info.process != IntPtr.Zero) TerminateProcess(info.process, 1); throw; }
        finally { if (info.thread != IntPtr.Zero) CloseHandle(info.thread); if (info.process != IntPtr.Zero) CloseHandle(info.process); if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
}
