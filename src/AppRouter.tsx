import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";

import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import AuthCallback from "./pages/AuthCallback";

export function AppRouter() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        {/* Main tabs - each tab gets its own route */}
        <Route path="/" element={<Navigate to="/reports" replace />} />
        <Route path="/events" element={<Index />} />
        <Route path="/users" element={<Index />} />
        <Route path="/users/:pubkey" element={<Index />} />
        <Route path="/reports" element={<Index />} />
        <Route path="/reports/:reportId" element={<Index />} />
        <Route path="/age-review" element={<Index />} />
        <Route path="/labels" element={<Index />} />
        <Route path="/settings" element={<Index />} />
        <Route path="/debug" element={<Index />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;