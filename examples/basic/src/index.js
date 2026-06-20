exports.handler = async (event) => {
  console.log("order-processor received:", JSON.stringify(event));
  return { processed: true };
};
