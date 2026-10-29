"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Turnstile } from "@marsidev/react-turnstile";
import { withCsrfHeaders } from "@/lib/csrf-client";

const TURNSTILE_FLAG = process.env.NEXT_PUBLIC_TURNSTILE_ENABLED?.toLowerCase();
const TURNSTILE_ENABLED =
  TURNSTILE_FLAG === "true" ? true :
  TURNSTILE_FLAG === "false" ? false :
  process.env.NODE_ENV === "production";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: withCsrfHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          name,
          email,
          password,
          turnstileToken: TURNSTILE_ENABLED ? turnstileToken : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Registration failed");

      router.push("/login?registered=true");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div className="glass-panel" style={{ width: "100%", maxWidth: "400px", padding: "2.5rem", borderRadius: "var(--radius-lg)" }}>
        <h2 className="title-gradient" style={{ fontSize: "2rem", fontWeight: "700", marginBottom: "0.5rem", textAlign: "center" }}>Create Account</h2>
        <p style={{ color: "var(--text-secondary)", marginBottom: "2rem", textAlign: "center" }}>Sign up to manage your shared links</p>

        {error && <div style={{ color: "#ff4444", marginBottom: "1rem", fontSize: "0.9rem", background: "rgba(255, 0, 0, 0.1)", padding: "0.75rem", borderRadius: "var(--radius-sm)" }}>{error}</div>}

        <form onSubmit={handleRegister} style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Display Name (Optional)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="input-field"
              placeholder="John Doe"
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Email Address</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="input-field"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="input-field"
              placeholder="Strong password"
            />
            <p style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              Use at least 12 characters with uppercase, lowercase, number, and symbol.
            </p>
          </div>
          {TURNSTILE_ENABLED ? (
            <div style={{ display: "flex", justifyContent: "center", minHeight: "65px" }}>
              <Turnstile
                siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "0x4AAAAAAFrUwteEs64_zkZa"}
                onSuccess={(token) => setTurnstileToken(token)}
              />
            </div>
          ) : (
            <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", textAlign: "center" }}>
              Turnstile disabled for local development.
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={loading || (TURNSTILE_ENABLED && !turnstileToken)} style={{ width: "100%", padding: "1rem" }}>
            {loading ? "Loading, please wait..." : "Sign Up"}
          </button>
        </form>

        <div style={{ margin: "2rem 0", display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ flex: 1, height: "1px", background: "var(--glass-border)" }}></div>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>OR</span>
          <div style={{ flex: 1, height: "1px", background: "var(--glass-border)" }}></div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <button onClick={() => signIn("google", { callbackUrl: "/dashboard" })} className="btn btn-secondary" style={{ width: "100%", background: "white", color: "black", border: "none" }}>
            <img src="https://authjs.dev/img/providers/google.svg" width="20" height="20" alt="Google" style={{ marginRight: "0.5rem" }} />
            Sign up with Google
          </button>
          <button onClick={() => signIn("github", { callbackUrl: "/dashboard" })} className="btn btn-secondary" style={{ width: "100%", background: "#24292e", color: "white", border: "none" }}>
            <img src="https://authjs.dev/img/providers/github.svg" width="20" height="20" alt="GitHub" style={{ marginRight: "0.5rem", filter: "invert(1)" }} />
            Sign up with GitHub
          </button>
        </div>

        <p style={{ marginTop: "2rem", textAlign: "center", color: "var(--text-secondary)", fontSize: "0.9rem" }}>
          Already have an account? <Link href="/login" style={{ color: "var(--accent-blue)", textDecoration: "none" }}>Log In</Link>
        </p>
      </div>
    </main>
  );
}
