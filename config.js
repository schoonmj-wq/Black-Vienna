const firebaseConfig = {
  apiKey:            "AIzaSyB7W5xlyJIxciDvmAs6SwDxgKHvahEHK3k",
  authDomain:        "black-vienna.firebaseapp.com",
  databaseURL:       "https://black-vienna-default-rtdb.firebaseio.com",
  projectId:         "black-vienna",
  storageBucket:     "black-vienna.firebasestorage.app",
  messagingSenderId: "458220769884",
  appId:             "1:458220769884:web:58368eaf8162b12b014c99"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
