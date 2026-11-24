import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { CampusProvider } from "./lib/campusContext";
import { PersonaPicker } from "./routes/PersonaPicker";
import { StudentHome } from "./routes/StudentHome";
import { DriverHome } from "./routes/DriverHome";
import { OpsHome } from "./routes/OpsHome";
import { TapInPage } from "./tap/TapInPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <CampusProvider>
        <Routes>
          <Route path="/" element={<PersonaPicker />} />
          <Route path="/student/*" element={<StudentHome />} />
          <Route path="/driver" element={<DriverHome />} />
          <Route path="/ops" element={<OpsHome />} />
          {/* Phase 4 Tap-In: NFC tags and QR codes open this URL (outside the Student area so the point is kept). */}
          <Route path="/tap/:campusId/:locationId" element={<TapInPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </CampusProvider>
    </BrowserRouter>
  </StrictMode>,
);
