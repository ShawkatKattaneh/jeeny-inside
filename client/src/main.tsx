import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { CampusProvider } from "./lib/campusContext";
import { PersonaPicker } from "./routes/PersonaPicker";
import { StudentHome } from "./routes/StudentHome";
import { DriverHome } from "./routes/DriverHome";
import { OpsHome } from "./routes/OpsHome";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <CampusProvider>
        <Routes>
          <Route path="/" element={<PersonaPicker />} />
          <Route path="/student/*" element={<StudentHome />} />
          <Route path="/driver" element={<DriverHome />} />
          <Route path="/ops" element={<OpsHome />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </CampusProvider>
    </BrowserRouter>
  </StrictMode>,
);
