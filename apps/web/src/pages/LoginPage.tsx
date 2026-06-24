import { useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import { Shell } from "../app/Shell";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { navigate } from "../router";

export function LoginPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [stage, setStage] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const finish = async () => {
    await onSignedIn();
    navigate("/");
  };

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ mfaRequired?: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      // With MFA on, the password only earns a challenge — collect the code next.
      if (result.mfaRequired) {
        setStage("mfa");
        return;
      }
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ token: code }) });
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify the code");
    }
  };

  const backToCredentials = () => {
    setStage("credentials");
    setCode("");
    setError("");
  };

  if (stage === "mfa") {
    return (
      <Shell>
        <form className="stack" onSubmit={submitCode}>
          <p className="eyebrow">Two-factor authentication</p>
          <h1>Enter your code</h1>
          <p>Open your authenticator app and enter the 6-digit code. You can also use a backup code.</p>
          <Field label="Authentication code" value={code} onChange={setCode} autoComplete="one-time-code" />
          {error && <MessageBox tone="error" title="Unable to verify">{error}</MessageBox>}
          <button className="primary-button">Verify</button>
          <button type="button" className="text-button" onClick={backToCredentials}>Back to sign in</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="stack" onSubmit={submitCredentials}>
        <p className="eyebrow">Welcome back</p>
        <h1>Sign in</h1>
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="current-password"
        />
        {error && <MessageBox tone="error" title="Unable to sign in">{error}</MessageBox>}
        <button className="primary-button">Sign in</button>

        <div className="login-qr">
          <div className="login-qr-code">
            <QRCodeSVG value={window.location.href} size={128} bgColor="#ffffff" fgColor="#031116" />
          </div>
          <span>Scan to open this page on another device</span>
        </div>
      </form>
    </Shell>
  );
}
