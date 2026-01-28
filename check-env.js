require("dotenv").config();

console.log("TEST_USER_ID =", process.env.TEST_USER_ID);
console.log("LINE_CHANNEL_ACCESS_TOKEN =", process.env.LINE_CHANNEL_ACCESS_TOKEN ? "OK" : "NG");
