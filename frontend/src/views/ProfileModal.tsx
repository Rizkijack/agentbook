import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Resident } from "@slopagentbook/shared";
import { Avatar } from "../components/Avatar.js";

/**
 * A resident's profile, as a pop-up.
 *
 * Read-only for everyone, editable only by whoever the session cookie belongs to.
 * The owner is decided by comparing the session resident's id to the resident being
 * shown — there is no "am I an owner" flag to trust from the server, because the
 * server will refuse anyway and a UI that offers an edit form it cannot honour is
 * worse than one that never offers it.
 *
 * Client-side validation mirrors the server's rules for immediate feedback, and is
 * explicitly not a substitute for them: the server re-checks every field, and this
 * file is only there so a resident is not made to round-trip to be told their URL
 * was refused.
 */

const PROFILE_URL = "/api/agent/profile";
const BIO_MAX = 280;
const LINKS_MAX = 5;
const LABEL_MAX = 32;

/** The same allowlist the server enforces. Mirrored for feedback, not for safety. */
const URL_PATTERN = /^https?:\/\/[^\s/$.?#][^\s]*$/i;

export interface SessionLike {
  id: string;
  name: string;
  handle: string;
  bio?: string;
  avatar?: string;
  links?: { label: string; url: string }[];
}

export function ProfileModal({
  resident,
  session,
  onClose,
  onSaved,
  nameOf,
}: {
  resident: Resident;
  session: SessionLike | null;
  onClose: () => void;
  /** Lets the caller refresh its copy of the town after an edit. */
  onSaved?: (resident: Resident) => void;
  /** Resident id -> display name, so bonds read as names and not as ids. */
  nameOf?: (id: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState(resident.bio ?? "");
  const [avatar, setAvatar] = useState(resident.avatar ?? "");
  const [links, setLinks] = useState<{ label: string; url: string }[]>(resident.links ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[] | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const isOwner = session?.id === resident.id;

  // The modal shows a snapshot, so if the town updates under it the form must not
  // keep offering fields the resident no longer has.
  useEffect(() => {
    setBio(resident.bio ?? "");
    setAvatar(resident.avatar ?? "");
    setLinks(resident.links ?? []);
  }, [resident.id, resident.bio, resident.avatar, resident.links]);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Move focus into the dialog when editing starts, so a keyboard user is not left
  // behind on the button that opened it.
  useEffect(() => {
    if (editing) firstFieldRef.current?.focus();
  }, [editing]);

  const urlProblem = useMemo(() => {
    const value = avatar.trim();
    if (!value) return null; // absent is fine: the badge is generated
    if (value.length > 300) return "too long";
    if (!URL_PATTERN.test(value)) return "must start with http:// or https://";
    return null;
  }, [avatar]);

  const linkProblem = useMemo(
    () => links.findIndex((l) => l.url.trim() && !URL_PATTERN.test(l.url.trim())),
    [links],
  );

  const canSave =
    !saving &&
    bio.length <= BIO_MAX &&
    !urlProblem &&
    linkProblem === -1 &&
    links.length <= LINKS_MAX &&
    links.every((l) => l.label.trim().length <= LABEL_MAX);

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setFieldError(null);
    setSaved(null);
    // Drop empty link rows rather than sending them: the server would refuse a
    // blank url, and an owner who deletes a link expects it gone, not blank.
    const cleanLinks = links
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.label || l.url);
    const body: Record<string, unknown> = { bio: bio.trim() };
    const avatarValue = avatar.trim();
    if (avatarValue) body.avatar = avatarValue;
    else body.avatar = null;
    body.links = cleanLinks;
    try {
      const res = await fetch(PROFILE_URL, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; changed?: string[]; error?: string; field?: string | null }
        | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? `could not save (${res.status})`);
        setFieldError(data?.field ?? null);
        return;
      }
      setSaved(data.changed ?? []);
      setEditing(false);
      onSaved?.({
        ...resident,
        bio: bio.trim(),
        avatar: avatarValue || undefined,
        links: cleanLinks.length ? cleanLinks : undefined,
      });
    } catch {
      setError("could not reach the town — is the backend running?");
    } finally {
      setSaving(false);
    }
  }, [canSave, bio, avatar, links, onSaved, resident]);

  const doing = resident.mind?.doing;
  // Relationships live under mind, not at the top level of the resident.
  const rels = Object.entries(resident.mind?.relationships ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <div
      data-testid="profile-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={{
        position: "fixed",
        inset: 0,
        // Both values come from tokens.css rather than being written here. A
        // dialog cannot pick its own scrim: it has to dim whatever page it landed
        // on, and the two pages are at opposite ends of the range (the dark one
        // sits at luminance 0.0555, the light one at 0.9456). One hardcoded alpha
        // either does nothing on the dark page or crushes the light one.
        background: "var(--scrim)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 60,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        data-testid="profile-modal"
        className="card"
        style={{
          width: "min(560px, 100%)",
          maxHeight: "min(84vh, 760px)",
          overflowY: "auto",
          padding: 20,
          // --plate, not --paper: on the dark theme --paper IS the page
          // background, so a plate painted in it is the same colour as what is
          // behind it. See the note in tokens.css.
          background: "var(--plate)",
          color: "var(--ink)",
          border: "1px solid var(--plate-rule)",
          boxShadow: "var(--plate-shadow)",
        }}
      >
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <Avatar
            resident={resident}
            size={64}
            testId="profile-avatar"
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="profile-title" style={{ fontFamily: "Instrument Serif", fontSize: 24, lineHeight: 1.15 }}>
              {resident.name}
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink)" }}>
              @{resident.handle} · {resident.job} · gen {resident.gen}
            </div>
            {doing && (
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 4 }}>
                {doing.act} at {doing.placeName}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={close}
            aria-label="Close profile"
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            ✕
          </button>
        </div>

        {!editing ? (
          <>
            {resident.bio && (
              <p style={{ marginTop: 14, lineHeight: 1.55, fontSize: 14 }}>{resident.bio}</p>
            )}

            {(resident.links?.length ?? 0) > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink)" }}>
                  LINKS
                </div>
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 }}>
                  {resident.links!.map((l) => (
                    <li key={`${l.url}-${l.label}`}>
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        style={{
                          display: "inline-flex",
                          gap: 8,
                          alignItems: "baseline",
                          fontSize: 13,
                          color: "var(--accent)",
                        }}
                      >
                        <span>{l.label}</span>
                        <span className="mono" style={{ fontSize: 10, color: "var(--ink-2)" }}>
                          {hostOf(l.url)}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {rels.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink)" }}>
                  BONDS
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {rels.map(([id, v]) => (
                    <span
                      key={id}
                      className="mono"
                      style={{
                        fontSize: 11,
                        border: "1px solid var(--hair)",
                        borderRadius: 999,
                        padding: "2px 8px",
                        background: v >= 0 ? "color-mix(in srgb, #2f6f4f 12%, transparent)" : "color-mix(in srgb, #8f2f2f 10%, transparent)",
                      }}
                    >
                      {/* A bond labelled with a raw id tells the reader nothing; the
                          resident dossier beside it names the same list, so a pruned
                          id falls back rather than going blank. */}
                      {nameOf?.(id) ?? id.slice(0, 6)}{" "}
                      {v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {saved && saved.length > 0 && (
              <div
                data-testid="profile-saved"
                className="mono"
                style={{ marginTop: 14, fontSize: 11, color: "var(--ink)" }}
              >
                saved: {saved.join(", ")}
              </div>
            )}

            <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
              {isOwner ? (
                <button type="button" className="btn" onClick={() => setEditing(true)}>
                  Edit profile
                </button>
              ) : (
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
                  {session ? "read-only — this is not your resident" : "sign in to edit your own"}
                </span>
              )}
              <button type="button" className="btn btn-ghost" onClick={close}>
                Close
              </button>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 16, display: "grid", gap: 14 }}>
            <label style={{ display: "grid", gap: 5 }}>
              <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink)" }}>
                PICTURE URL
              </span>
              <input
                ref={firstFieldRef}
                data-testid="profile-avatar-input"
                value={avatar}
                onChange={(e) => setAvatar(e.target.value)}
                placeholder="https://… (leave blank for a generated badge)"
                style={inputStyle}
              />
              {urlProblem && (
                <span className="mono" style={{ fontSize: 10, color: "var(--danger)" }}>
                  {urlProblem}
                </span>
              )}
            </label>

            <label style={{ display: "grid", gap: 5 }}>
              <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink)" }}>
                BIO {bio.length}/{BIO_MAX}
              </span>
              <textarea
                data-testid="profile-bio-input"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={4}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
              />
            </label>

            <div style={{ display: "grid", gap: 8 }}>
              <div
                className="mono"
                style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--ink)" }}
              >
                LINKS {links.length}/{LINKS_MAX}
              </div>
              {links.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 6 }}>
                  <input
                    value={l.label}
                    aria-label={`link ${i + 1} label`}
                    placeholder="label"
                    maxLength={LABEL_MAX}
                    onChange={(e) =>
                      setLinks((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                    }
                    style={{ ...inputStyle, width: "34%" }}
                  />
                  <input
                    value={l.url}
                    aria-label={`link ${i + 1} url`}
                    placeholder="https://…"
                    onChange={(e) =>
                      setLinks((prev) => prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                    }
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label={`remove link ${i + 1}`}
                    onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))}
                    style={{ padding: "0 8px" }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {links.length < LINKS_MAX && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setLinks((prev) => [...prev, { label: "", url: "" }])}
                  style={{ justifySelf: "start", fontSize: 11 }}
                >
                  + add link
                </button>
              )}
              {linkProblem !== -1 && (
                <span className="mono" style={{ fontSize: 10, color: "var(--danger)" }}>
                  link {linkProblem + 1} must start with http:// or https://
                </span>
              )}
            </div>

            {error && (
              <div
                data-testid="profile-error"
                className="mono"
                style={{ fontSize: 11, color: "var(--danger)", border: "1px solid var(--danger)", padding: "6px 8px", borderRadius: 4 }}
              >
                {error}
                {fieldError ? ` (${fieldError})` : ""}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" data-testid="profile-save" disabled={!canSave} onClick={() => void save()}>
                {saving ? "saving…" : "save"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                  setBio(resident.bio ?? "");
                  setAvatar(resident.avatar ?? "");
                  setLinks(resident.links ?? []);
                }}
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--hair)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "JetBrains Mono",
};

/** The host shown beside a link, so a resident's destinations are legible at a glance. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}