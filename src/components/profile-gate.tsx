"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const FREE = ["/account", "/login", "/auth", "/offline"];

/**
 * Première connexion : tant que le prénom n'est pas renseigné, l'utilisateur connecté est conduit
 * vers « Mon compte » (puis ramené où il allait). La base l'exige de toute façon pour réserver.
 */
export function ProfileGate() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();

  useEffect(() => {
    if (FREE.some((p) => pathname.startsWith(p))) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user || cancelled) return;
      const { data, error } = await supabase.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
      if (cancelled || error || !data) return;
      if (!data.full_name?.trim()) router.replace(`/account?bienvenue=1&next=${encodeURIComponent(pathname)}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
