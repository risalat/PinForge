import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PopupApp } from './App'
import './popup.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
)
