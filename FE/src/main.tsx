import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('找不到應用程式根節點。')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
