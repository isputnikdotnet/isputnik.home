import { useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import { Shell } from "../app/Shell";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { navigate } from "../router";

export function LoginPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await onSignedIn();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
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
