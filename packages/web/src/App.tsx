import { useCallback, useEffect, useState } from "react";
import { AuthFailure, getSession, logout } from "./api.ts";
import { Plaque } from "./Plaque.tsx";
import { SignIn, Setup } from "./AuthScreens.tsx";
import { Shell } from "./Shell.tsx";
import type { SessionEndInfo } from "./sync/client.ts";

type Phase =
  | { name: "checking" }
  | { name: "unreachable"; message: string }
  | { name: "setup" }
  | { name: "sign-in"; notice?: string }
  | { name: "shell" };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [signOutError, setSignOutError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);

  // Ask the server who we are. The request is cancelled if the page leaves or a new check starts.
  useEffect(() => {
    const controller = new AbortController();
    setPhase({ name: "checking" });
    getSession(controller.signal).then(
      (s) => setPhase(s.setupRequired ? { name: "setup" } : s.signedIn ? { name: "shell" } : { name: "sign-in" }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ name: "unreachable", message: e instanceof AuthFailure ? e.message : "Something went wrong. Try again." });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const signOut = useCallback(async () => {
    setSignOutError(undefined);
    try {
      await logout();
      setPhase({ name: "sign-in", notice: "You are signed out." });
    } catch (e) {
      setSignOutError(e instanceof AuthFailure ? e.message : "Could not sign out. Try again.");
    }
  }, []);

  const sessionEnded = useCallback((info: SessionEndInfo) => {
    const more = info.lost
      ? " This browser could not keep a copy of the text you had not saved, so that text is lost."
      : info.kept ? " Text that was not saved is kept on this device, and comes back when you open that scene." : "";
    setPhase({ name: "sign-in", notice: `Your sign-in ended. Sign in again.${more}` });
  }, []);

  if (phase.name === "shell") return <Shell onSignOut={signOut} signOutError={signOutError} onSessionEnded={sessionEnded} />;

  return (
    <div className="frame frame--auth">
      <header className="top">
        <Plaque />
      </header>
      <main className="auth-main" id="main">
        {phase.name === "checking" && (
          <section className="card auth-card" aria-labelledby="auth-title">
            <h2 id="auth-title">Opening your studio</h2>
            <p role="status">Checking your sign-in…</p>
          </section>
        )}
        {phase.name === "unreachable" && (
          <section className="card auth-card" aria-labelledby="auth-title">
            <h2 id="auth-title">Cannot open the studio</h2>
            <p role="alert" className="error">{phase.message}</p>
            <button type="button" className="btn btn--primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </section>
        )}
        {phase.name === "setup" && (
          <Setup onDone={() => setPhase({ name: "shell" })} onFallback={(notice) => setPhase({ name: "sign-in", notice })} />
        )}
        {phase.name === "sign-in" && (
          <SignIn {...(phase.notice ? { notice: phase.notice } : {})} onDone={() => setPhase({ name: "shell" })} />
        )}
      </main>
    </div>
  );
}
