/* eslint-disable @typescript-eslint/no-var-requires */
const { Lambda } = require("@aws-sdk/client-lambda");
const { resolve } = require("path");
const { readFileSync } = require("fs");

const Constants = {
  LambdaName: "SesToDiscourseLambda",
};

const lambda = new Lambda({
  region: "us-east-1",
});

lambda
  .updateFunctionCode({
    FunctionName: Constants.LambdaName,
    ZipFile: readFileSync(resolve(__dirname, "../bundle.zip")),
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
