import { useState, type FormEvent } from "react";
import { Shell } from "../app/Shell";
import { Field } from "./Field";
import { MessageBox } from "./MessageBox";

export function AccountForm({
  eyebrow,
  title,
  submitLabel,
  helper,
  onSubmit
}: {
  eyebrow: string;
  title: string;
  submitLabel: string;
  helper: string;
  onSubmit: (payload: { displayName: string; email: string; password: string }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Password and confirmation must match.");
      return;
    }

    try {
      await onSubmit({ displayName, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create account");
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <MessageBox tone="info" title="Account setup">{helper}</MessageBox>
        <MessageBox tone="warning" title="Password policy">
          Use at least 8 characters. A memorable example pattern is two words, a number, and a symbol, like{" "}
          <code>River7Table!</code>.
        </MessageBox>
        <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" />
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          minLength={8}
          autoComplete="new-password"
        />
        {error && <MessageBox tone="error" title="Account setup needs attention">{error}</MessageBox>}
        <button className="primary-button">{submitLabel}</button>
      </form>
    </Shell>
  );
}
