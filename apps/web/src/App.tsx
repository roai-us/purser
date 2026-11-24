import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router";
import { api, UNAUTHORIZED_EVENT } from "./api/client";
import { Shell } from "./components/Shell";
import { ErrorNote, Loading } from "./components/Notice";
import { Login } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { AgentsPage } from "./pages/Agents";
import { ProvidersPage } from "./pages/Providers";
import { ActivityPage } from "./pages/Activity";
import { LogsPage } from "./pages/Logs";
import { SecurityPage } from "./pages/Security";
import { SettingsPage } from "./pages/Settings";
import { MyAgentsPage } from "./pages/MyAgents";
import { ApprovalsPage, RequestsPage } from "./pages/Requests";
import { PeoplePage } from "./pages/People";
import { DepartmentsPage } from "./pages/Departments";
import { WorkflowsPage } from "./pages/Workflows";
import { WorkflowDetailPage } from "./pages/WorkflowDetail";
import { RoiReportPage } from "./pages/RoiReport";
import type { ViewerInfo } from "./api/types";
import { ViewerProvider } from "./lib/agentApi";

export function App() {
  const queryClient = useQueryClient();
  /** Forgets every cached answer except the session itself. */
  const setSignedIn = (authenticated: boolean) => {
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== "session",
    });
    if (authenticated) {
      // Ask the server who signed in, to pick the right pages.
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    } else {
      queryClient.setQueryData(["session"], { authenticated: false });
    }
  };
  const session = useQuery({ queryKey: ["session"], queryFn: api.session });

  useEffect(() => {
    const onUnauthorized = () =>
      queryClient.setQueryData(["session"], { authenticated: false });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (session.isPending) return <Loading label="Starting" />;
  if (session.isError) {
    return (
      <div className="login">
        <div className="login-card">
          <ErrorNote error={session.error} />
        </div>
      </div>
    );
  }
  if (!session.data.authenticated) {
    return <Login onSignedIn={() => setSignedIn(true)} />;
  }

  const viewer: ViewerInfo = session.data.viewer ?? {
    kind: "owner",
    role: "admin",
    name: "Purser admin",
  };
  const shell = (
    <Shell
      viewer={viewer}
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        setSignedIn(false);
      }}
    />
  );

  return (
    <ViewerProvider viewer={viewer}>
      {viewer.role === "admin" ? (
        <Routes>
          <Route element={shell}>
            <Route index element={<HomePage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="workflows" element={<WorkflowsPage />} />
            <Route path="workflows/:ref" element={<WorkflowDetailPage />} />
            <Route path="workflows/:ref/report" element={<RoiReportPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="departments" element={<DepartmentsPage />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="requests" element={<RequestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      ) : (
        <Routes>
          <Route element={shell}>
            <Route index element={<Navigate to="/agents" replace />} />
            <Route path="agents" element={<MyAgentsPage />} />
            <Route path="requests" element={<RequestsPage />} />
            {viewer.role === "manager" && (
              <Route path="approvals" element={<ApprovalsPage />} />
            )}
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Route>
        </Routes>
      )}
    </ViewerProvider>
  );
}
