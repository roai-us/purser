import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { meApi } from "../api/client";
import type { Role, ViewerInfo } from "../api/types";
import { Logo } from "./Logo";
import { StatusBar } from "./StatusBar";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Shows the number of requests waiting for this person. */
  badge?: boolean;
}

/** What each role sees in the sidebar. */
export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { to: "/", label: "Home", end: true },
    { to: "/agents", label: "Agents" },
    { to: "/workflows", label: "Workflows" },
    { to: "/approvals", label: "Approvals", badge: true },
    { to: "/people", label: "People" },
    { to: "/departments", label: "Departments" },
    { to: "/logs", label: "Call log" },
    { to: "/providers", label: "Providers" },
    { to: "/activity", label: "Activity" },
    { to: "/security", label: "Security" },
    { to: "/settings", label: "Settings" },
  ],
  manager: [
    { to: "/agents", label: "Agents" },
    { to: "/approvals", label: "Approvals", badge: true },
    { to: "/requests", label: "My requests" },
  ],
  member: [
    { to: "/agents", label: "My agents" },
    { to: "/requests", label: "My requests" },
  ],
};

const ROLE_NAMES: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  member: "Employee",
};

export function Shell({
  viewer,
  onLogout,
}: {
  viewer: ViewerInfo;
  onLogout: () => void;
}) {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: meApi.me,
    refetchInterval: 30_000,
  });
  const waiting = me.data?.pending.toDecide ?? 0;
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <Logo />
          <span className="brand-name">Purser</span>
        </div>
        <ul className="nav-list">
          {NAV[viewer.role].map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  isActive ? "nav-link nav-active" : "nav-link"
                }
              >
                {item.label}
                {item.badge && waiting > 0 && (
                  <span className="nav-badge" aria-label={`${waiting} waiting`}>
                    {waiting}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <span className="viewer-name">{viewer.name}</span>
          <span>
            {ROLE_NAMES[viewer.role]}
            {viewer.department ? `, ${viewer.department}` : ""}
          </span>
          {viewer.kind === "owner" && (
            <span className="mono">{window.location.host}</span>
          )}
          <button type="button" className="link-button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        <StatusBar
          source={
            viewer.role === "admin"
              ? "admin"
              : viewer.role === "manager"
                ? "team"
                : "mine"
          }
        />
        <Outlet />
      </main>
    </div>
  );
}
