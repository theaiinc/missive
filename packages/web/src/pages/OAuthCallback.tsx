import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("Exchanging authorization code...");

  useEffect(() => {
    const code = searchParams.get("code");
    const error = searchParams.get("error");
    const state = searchParams.get("state") ?? "gmail"; // default to gmail for backward compat

    if (error || !code) {
      navigate(`/settings?error=${error ?? "access_denied"}`);
      return;
    }

    fetch(`/api/v1/connector/${state}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          navigate(`${state === "gcal" ? "/calendar" : "/settings"}?error=${data.error}`);
        } else {
          // A calendar connection returns to the calendar, where its calendars appear.
          navigate(
            `${state === "gcal" ? "/calendar" : "/settings"}?connected=${state}&email=${encodeURIComponent(data.email ?? "")}`
          );
        }
      })
      .catch(() => {
        navigate("/settings?error=callback_error");
      });
  }, [searchParams, navigate]);

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-sm text-muted-foreground">{status}</p>
      </div>
    </div>
  );
}