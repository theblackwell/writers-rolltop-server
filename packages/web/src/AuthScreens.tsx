import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AuthFailure, PASSWORD_MIN_CHARS, login, passwordLength, setup } from "./api.ts";

// The password and token live only in these components' state while the person types. They are not written to
// localStorage, sessionStorage, the URL or any other place, and they are cleared when the form is done.

function useAbortOnUnmount() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return () => {
    ref.current?.abort();
    ref.current = new AbortController();
    return ref.current.signal;
  };
}

const messageOf = (e: unknown, fallback: string) => (e instanceof AuthFailure ? e.message : fallback);
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export function SignIn({ onDone, notice }: { onDone: () => void; notice?: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nextSignal = useAbortOnUnmount();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password === "") { setError("Enter your password."); return; }
    setBusy(true);
    setError(undefined);
    try {
      await login(password, nextSignal());
      setPassword("");
      onDone();
    } catch (err) {
      if (isAbort(err)) return;
      setError(messageOf(err, "Sign-in did not work. Try again."));
      setBusy(false);
    }
  }

  return (
    <section className="card auth-card" aria-labelledby="auth-title">
      <h2 id="auth-title">Sign in</h2>
      {notice && <p role="status" className="success">{notice}</p>}
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={error ? "auth-error" : undefined} />
        </div>
        {error && <p id="auth-error" role="alert" className="error">{error}</p>}
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </section>
  );
}

export function Setup({ onDone, onFallback }: { onDone: () => void; onFallback: (notice: string) => void }) {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nextSignal = useAbortOnUnmount();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (token.trim() === "") { setError("Enter the setup token from the server log."); return; }
    if (passwordLength(password) < PASSWORD_MIN_CHARS) {
      setError(`The password must be at least ${PASSWORD_MIN_CHARS} characters.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const signal = nextSignal();
    try {
      await setup(token.trim(), password, signal);
    } catch (err) {
      if (isAbort(err)) return;
      setError(messageOf(err, "Setup did not work. Try again."));
      setBusy(false);
      return;
    }
    // The account exists. Sign in with the same password, then let go of it.
    try {
      await login(password, signal);
      setToken("");
      setPassword("");
      onDone();
    } catch (err) {
      if (isAbort(err)) return;
      setToken("");
      setPassword("");
      onFallback("Your account is ready. Sign in with your new password.");
    }
  }

  return (
    <section className="card auth-card" aria-labelledby="auth-title">
      <h2 id="auth-title">Set up your studio</h2>
      <p>Start the first run here. The server prints a setup token in its log when it starts.</p>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="setup-token">Setup token</label>
          <input id="setup-token" name="setup-token" type="text" autoComplete="off" autoCapitalize="off"
            spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input id="new-password" name="new-password" type="password" autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? "setup-hint auth-error" : "setup-hint"} />
          <p id="setup-hint" className="hint">At least {PASSWORD_MIN_CHARS} characters.</p>
        </div>
        {error && <p id="auth-error" role="alert" className="error">{error}</p>}
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Setting up…" : "Create account"}</button>
      </form>
    </section>
  );
}
