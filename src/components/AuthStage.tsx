import { Fragment, type ReactNode } from "react";
import { SignInBackdrop } from "@/components/SignInBackdrop";

const HEADLINE = ["Service", "Line", "Portfolio", "Tracker"];

export type AuthStageState = "error" | "warning" | "info";

/**
 * The frame shared by /signin and /set-password: the animated backdrop (grid, portfolio wall, heartbeat line, pulse
 * orb), the headline, and the glass card centered on the heartbeat line. `state` drives the card's motion in
 * signin.css: error = one shake and a red flash, warning = amber border and slower rings, info = no extra motion.
 */
export function AuthStage({ state, children }: { state?: AuthStageState; children: ReactNode }) {
  return (
    <main className="si-stage" data-state={state}>
      <SignInBackdrop />
      <div className="si-center">
        <h1 className="si-headline">
          {HEADLINE.map((word, i) => (
            <Fragment key={word}>
              {i > 0 && " "}
              <span className="si-word" style={{ animationDelay: `${0.05 + i * 0.1}s` }}>
                {word}
              </span>
            </Fragment>
          ))}
        </h1>
        <div className="si-card-shell">
          <div className="si-card">{children}</div>
        </div>
      </div>
    </main>
  );
}

/** 14px outline icons for auth messages: a clock for the pauses, "i" for info, "!" for errors. */
export function AuthMessageIcon({ kind }: { kind: "clock" | "info" | "alert" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      {kind === "clock" && <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
      {kind === "info" && (
        <>
          <path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.9" fill="currentColor" />
        </>
      )}
      {kind === "alert" && (
        <>
          <path d="M8 4.6v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="11" r="0.9" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
