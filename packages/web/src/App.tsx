import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Inbox } from "./pages/Inbox";
import { ThreadView } from "./pages/ThreadView";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Rules } from "./pages/Rules";
import { OAuthCallback } from "./pages/OAuthCallback";
import { ChatProvider } from "./hooks/useChat";
import { NotificationProvider } from "./hooks/useNotificationContext";

export function App() {
  return (
    <ChatProvider>
      <NotificationProvider>
        <Routes>
          <Route path="/oauth" element={<OAuthCallback />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/inbox" replace />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/thread/:id" element={<ThreadView />} />
            <Route path="/search" element={<Search />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </NotificationProvider>
    </ChatProvider>
  );
}