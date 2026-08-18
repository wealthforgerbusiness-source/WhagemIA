import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD0OS1WHYwd8pwpp1J23muqPijuDhx3AjI",
  authDomain: "whagemia.firebaseapp.com",
  projectId: "whagemia",
  storageBucket: "whagemia.firebasestorage.app",
  messagingSenderId: "89697235890",
  appId: "1:89697235890:web:e785de2468275d2e5eeaab"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { auth, googleProvider };
