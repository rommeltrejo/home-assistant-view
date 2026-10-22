// Offline identity fixtures only. Public self-signed test certificates, no private keys,
// no store writes, no public-trust acceptance. Compile with Kiosk.cs /main:HAView.SigningPolicyTests.
using System;
using System.IO;
using System.Security.Cryptography.X509Certificates;
using System.Web.Script.Serialization;
namespace HAView {
internal static class SigningPolicyTests {
    static int count;
    static void Assert(bool ok, string name) { if (!ok) throw new Exception(name); count++; Console.WriteLine("PASS " + name); }
    static void Reject(Action action, string name) { bool failed = false; try { action(); } catch (Exception) { failed = true; } Assert(failed, name); }
    public static int Main() {
        try {
            string oid = "1.3.6.1.4.1.311.97.990309390.766961637.194916062.941502583";
            string pin = new string('A', 40);
            Reject(() => PublisherPolicy.Parse(false, null, null), "missing strict policy");
            Reject(() => PublisherPolicy.Parse(false, pin, oid), "ambiguous strict policy");
            Reject(() => PublisherPolicy.Parse(true, pin, oid), "ambiguous development policy");
            foreach (string bad in new [] { "", " ", "1.3.6.1.5.5.7.3.3", "2.5.29.37.0", "1.3.6.1.4.1.311.97.1.0", oid + ".", oid + "\n", oid + ".01", oid + ".4294967296", "1.3.6.1.4.1.311.97.1.3.1" }) {
                string value = bad; Reject(() => PublisherPolicy.Parse(false, null, value), "malformed/non-profile OID: " + value.Replace("\n", "newline"));
            }
            // Reproduce the independent validator's subscriber/CI-policy acceptance.
            foreach (string reserved in new [] {
                "1", "1.0", "1.0.0", "1.0.2.3.4.5", "1.2.3.4",
                "1.3.1", "1.3.1.0",
                "1.3.1.29433.35007.34545.16815.37291.11644.53265.56135",
                "1.4.1", "1.4.1.0",
                "1.4.1.29433.35007.34545.16815.37291.11644.53265.56135"
            }) {
                string value = "1.3.6.1.4.1.311.97." + reserved;
                Reject(() => PublisherPolicy.Parse(false, null, value), "reserved branch strict: " + value);
                Reject(() => PublisherPolicy.Parse(true, null, value), "reserved branch development: " + value);
            }
            // Syntax checks do not derive a fixed suffix length from Microsoft's example.
            foreach (string suffix in new [] { "2", "2.3.4", "2.3.4.5.6", "10.0.4294967295" }) {
                string value = "1.3.6.1.4.1.311.97." + suffix;
                Assert(PublisherPolicy.Parse(false, null, value).ProfileEku == value, "canonical exact variable-arity OID: " + value);
            }
            Reject(() => PublisherPolicy.Parse(false, pin + "\n", null), "malformed thumbprint");
            Reject(() => PublisherPolicy.Parse(true, null, ""), "empty supplied development policy");
            Assert(PublisherPolicy.Parse(true, null, null) != null, "explicit unsigned development preserved");
            var json = new JavaScriptSerializer();
            var legacy = json.Deserialize<Active>("{\"schema\":1,\"version\":\"legacy\",\"publisher\":\"" + pin + "\",\"allowUnsigned\":false}");
            var roundtrip = json.Deserialize<Active>(json.Serialize(legacy));
            Assert(PublisherPolicy.Parse(false, roundtrip.publisher, roundtrip.publisherProfileEku).Thumbprint == pin && roundtrip.publisherProfileEku == null, "legacy active roundtrip");
            var active = json.Deserialize<Active>(json.Serialize(new Active { version = "managed", publisherProfileEku = oid }));
            Assert(PublisherPolicy.Parse(false, active.publisher, active.publisherProfileEku).ProfileEku == oid, "exact managed active roundtrip");
            var policy = PublisherPolicy.Parse(false, null, oid);
            var first = new X509Certificate2(Convert.FromBase64String("MIIDWzCCAkOgAwIBAgIUeNKuXv5MuIE47q/fOsPFekZ+UgMwDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAwMB4XDTI2MTAxODIyMjcyNloXDTI2MTAyMDIyMjcyNlowIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAwMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAol/HQzfZwTDUO/vwaKX04q0lP8hOPUJLs0z2qM1BokFjCStUA2e+Iuk9VGtJTqhB06QhF8fdS+ro84lsSs9O6G9Bhjo63aun9p65hrrTKaz8NQSsP8dZL0+nrsqXeqPMkwiapTiAYLN6se49UEuNfF2ekidHZ3YhrbCz0hABysQiBzKVh+O+bQRQkQbpayb4vh9up4xRwZmKmmRb5NLUeAw3CVpTWtpTm58y/2ROYHYNa9yTxoZslufWXvfSr7KctW34xGVP5CiApRDdrP73pk2XRu60mDoHzfUS9oltUP5pkdB25mdZYc5MwzkHhjtzEDIbjShOyXmXS4lNBZeEdwIDAQABo4GGMIGDMB0GA1UdDgQWBBQFk5qQCB91WPSxcco8J9/Yau3eTjAfBgNVHSMEGDAWgBQFk5qQCB91WPSxcco8J9/Yau3eTjAPBgNVHRMBAf8EBTADAQH/MDAGA1UdJQQpMCcGCCsGAQUFBwMDBhsrBgEEAYI3YYPYm9gOgu3bz2Xc+N1eg8D44HcwDQYJKoZIhvcNAQELBQADggEBAI829oItXid3p56MouKBQkOVK8xvf34QtaoXLag+/JbYay93jCjqIup73xUs2gnyvNHC0AJxSSSl10SJSjmFAF5ZEL6FLJgADIBetgX1yk85LVB8FJw2H8J6V3llgyr78wNZFmwD5uFU2OSA8U0g0oE9MMoF/uv+Cm4E0FqujDEQDgbNZwVM52Fw4rA9Gzom75AuY+KXkHxNLjSTyz1wd4Rt8pkLc2hr7ZAum5i0QVbDMo+EGhiV8YRXJrulJzt1/bXdbF9cc2GPxL6Pa0aAbX6dxSaGdWmnZF9ZMYkV7EhhhvQvbyqgO9PStCxn99hrkKMn3JqFgl+bFSaxLPevdT8="));
            var rotated = new X509Certificate2(Convert.FromBase64String("MIIDWzCCAkOgAwIBAgIUNYjf2rwfItECnNi3gS1A6qxXk7gwDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAxMB4XDTI2MTAxODIyMjcyNloXDTI2MTAyMDIyMjcyNlowIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAxMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtwXQIn/yyFFBWtaW3H74iRvEyKhWvOdNxDsj/qS9i4+TSZJxP8d31w2TtW+nVx4r1+c7EqLuLCp1rq2jBHhz1uHIl7tcQywrAjWZocd0aGe132O3CexGwbzocDnSP/JLl2uI0rBNfneMhj+oKFFhll2Z6f4DRM1zhZOoiZyJSdlakxMcimm2dOmtJaiOxSrlhf8eEsF4tLe24osEqGOM0CPIK2ybpDRbyNezMjluT6ijguXvASXLzA9kA1WJACw9ke6Y4ahIG5FpEgEMU5fEZYiX+AKsLLJJod0HJC287++/GGmhImrsU40D9SbZSOSYWfQXbyWBP9BDrcfn13TxmwIDAQABo4GGMIGDMB0GA1UdDgQWBBSoOCOyyBsjJnKKBtZH9v4Cc0LMzjAfBgNVHSMEGDAWgBSoOCOyyBsjJnKKBtZH9v4Cc0LMzjAPBgNVHRMBAf8EBTADAQH/MDAGA1UdJQQpMCcGCCsGAQUFBwMDBhsrBgEEAYI3YYPYm9gOgu3bz2Xc+N1eg8D44HcwDQYJKoZIhvcNAQELBQADggEBAH0sb+SPLC6x+/4gpa71cNaMHsHXVFa9cjmodSqYDrfE3IVsKsWWtp24U5y6EdTca4lt1x8xHVrc8EzO24hnuoVB7ekymXmNffxoijUOp7gJ3F4ENDUq/zeycZIQ6tA6D4SLaRIJ1qO3kOHylJziKj74e2zSeWxrpA/O3TmDKHDfaBigYsnyBRfksv5Bp1iLRPZH5CppzOgQlbbvw3XE0CDxCefZkN4AC0tjc+MNRBXYKBSOVLz7etzRConBGPAhaX80hHMHe135N4hwgvIIFVjAKyeH9UjhjMSC2CogwbRmwpUmy83Uehz7MYLQtFS3EU5fIUJqmt5lodL085yHzRE="));
            var wrong = new X509Certificate2(Convert.FromBase64String("MIIDXDCCAkSgAwIBAgIUHYhfSFUrCZ/uAcpRPuhYV2Tr2QMwDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAyMB4XDTI2MTAxODIyMjcyNloXDTI2MTAyMDIyMjcyNlowIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAyMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwlRL/s1IOKHv6Wa8YYY/8gkmIt2Z5bjadX+qRb6gDuBBZly0BpoOFAYwH6bKQFcGw01kLTkkw6hRUKfPMYL9KP3zMJDdmdEd6TLqPQYVNWT3tfo/BI2GCe0cIyT+JDeP7eqJxj+XMXhekHwKFjelIvcCYhGxh4X0EoPP/jZ+wPDSJAU0xeyEp65AD+S4HksOiHQf6pfYpfZUYw2GPGN5Pc/ypd/7B+kduHLBu49snXDBcQZV33L8ko2mDVDixwlX0mrYpXSDLdXnZZ/ILGLM2rn5GACXB37yKJAf2MGZh3YTnksK2ar/v5hHDqT/5MPCT5fBFQ5JW8vZaO97bpB1gQIDAQABo4GHMIGEMB0GA1UdDgQWBBT0V3XyyROgd+6hW4oe/GHYjZG5gTAfBgNVHSMEGDAWgBT0V3XyyROgd+6hW4oe/GHYjZG5gTAPBgNVHRMBAf8EBTADAQH/MDEGA1UdJQQqMCgGCCsGAQUFBwMDBhwrBgEEAYI3YYPYm9gOgu3bz2Xc+N1eg8D44HcJMA0GCSqGSIb3DQEBCwUAA4IBAQBPapd1k0PW+BkdzWzx8vL2odxkDYQL7CQi+h/TEN2nU1/9ewi6gQUzF//bnhYn9PgtNNBtHLKjOceYiw0ILoVXSENRtiaC+cBzsb+HAqapVb2xz51WqCpLa5QCvJsnneXucOJjaIBet9Ul2HJdnMNC9HbMOoxF11lq0Wc9w9TsAlbUAHv0o4hvoxwZ1QOicZyCYkno3LL86x3OA6Mn8KzxM83hhP83PEeq3Ci486uXV6SipB2klalbSwUPl/slsjbXgjTv6nNEsK8B5DaC99JwXB2GmnvHQfsEq3ExTSqwcAqd4Y9EcUEEt65TacxH9zoVvFF52zvbptx3lAZdbXx5"));
            var missing = new X509Certificate2(Convert.FromBase64String("MIIDJzCCAg+gAwIBAgIUJvKPgvNJYY3quj1Kw8pok34Fpk4wDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAzMB4XDTI2MTAxODIyMjcyNloXDTI2MTAyMDIyMjcyNlowIzEhMB8GA1UEAwwYT2ZmbGluZSBwb2xpY3kgZml4dHVyZSAzMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArjZbed8UPQH4bwilshrzC71gc0ILazS7HBVq4XASmpUqlZTghkzSlagJqjhfiYFFRl7Y+XVzSHYKXVbMgF328wgfpcFkomX1xuztinyKmiIWno+8tVyb1wmCMERO+AfpcfhbcokdjWW1h7R4y5y9gqU7g8+fC/1kmguGE1u3b9yJ+5j+xuO1BAmFg90ppUlb9Gubo3ce5l8gRNWq4PfjD8nE7XBHdKqc5lfxMYDl5gmtjSM2c54LdEWLFnMD/65xwaGr6wtK7e1LvAOXKVLMUp/hTn0pe/QfejgWdsr5EMBWQcgKLpWxDSSqXdgBWQFReB+Pa2/H6wFHBxA1FmXNSQIDAQABo1MwUTAdBgNVHQ4EFgQUZFTuWGNx0x9D6FIcY6kRok9iypgwHwYDVR0jBBgwFoAUZFTuWGNx0x9D6FIcY6kRok9iypgwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAP7d/cSPc3ABxEutT+KIzeUbGKY4sG15xOOeZWkM2VJsmHkkRJSBQt69PpgPA6bmoApp0gzzCzjPscqaFlDS4ysQejxHhoL9G0qjLQBsj/X4/Mz9gRVxGouPSC4Qy3z0V38Bn7y/sFE9Vuv6L4By3g+vH2z5nQcoCv4w8/NwcSsCBsb9Dygfyn0PTDB7VyXZdMXd6yKc9N23P8Dq/fGMZGF5sLXswsEiQCn8bhBcG2eZjrZeSP9fhCgtKBdQhaUEb8jS311sLR7m2dQ5I5lJRuUn3D39Pi7Yd5mAIdnajbRsan4HH3k5VFVnWuF/56sjg7FX3cxtjZVcuCjljhlKgcA=="));
            Assert(first.Thumbprint != rotated.Thumbprint, "rotated leaves differ");
            policy.Match(first); policy.Match(rotated); Assert(true, "same-profile rotated leaf identity match ONLY");
            Reject(() => policy.Match(wrong), "wrong profile identity");
            Reject(() => policy.Match(missing), "missing explicit EKU");
            Reject(() => policy.Match(null), "missing signer certificate");
            PublisherPolicy.Parse(false, first.Thumbprint.ToLowerInvariant(), null).Match(first);
            Assert(true, "legacy case-insensitive pin");
            Reject(() => PublisherPolicy.Parse(false, first.Thumbprint, null).Match(rotated), "legacy rotation mismatch");
            Reject(() => policy.VerifyManifestSigner(first, new X509Certificate2Collection()), "same profile UNTRUSTED chain rejected");
            Reject(() => policy.VerifyManifestSigner(wrong, new X509Certificate2Collection()), "wrong profile UNTRUSTED chain rejected");
            Reject(() => policy.VerifyManifestSigner(missing, new X509Certificate2Collection()), "CMS missing code-signing EKU rejected");
            Console.WriteLine("PASS " + count + " offline policy checks; no trust store modifications or public-trust claims"); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
}
