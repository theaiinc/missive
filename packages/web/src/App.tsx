import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Inbox } from "./pages/Inbox";
import { ThreadView } from "./pages/ThreadView";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { OAuthCallback } from "./pages/OAuthCallback";

export function App() {
  return (
    <Routes>
      <Route path="/oauth" element={<OAuthCallback />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/thread/:id" element={<ThreadView />} />
        <Route path="/search" element={<Search />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}