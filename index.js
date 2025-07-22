const express = require("express");
const cors = require("cors");
require("dotenv").config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 5000;

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.au1728f.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const parcelCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res
          .status(200)
          .send({ message: "User already exists", inserted: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      return res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });

    // GET parcels by user email, sorted by latest
    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.body.email;
        if (!userEmail) {
          return res
            .status(400)
            .send({ message: "Email query parameter is required" });
        }

        const query = userEmail ? { created_by: userEmail } : {};
        const options = { sort: { createdAt: -1 } }; // newest first
        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // get parcel by ID

    app.get("/parcels/:id", async (req, res) => {
      const { id } = req.params;

      // Validate MongoDB ObjectId
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }

      try {
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
      }
    });

    // create a new parcel through POST
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.log("error inserting parcel", error);
        res.status(500).send({ message: "Failed to insert a parcel" });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;

      try {
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // POST: Add a new tracking update
    app.post("/tracking", async (req, res) => {
      try {
        const { parcelId, status, note, updated_by = "" } = req.body;

        if (!parcelId || !status) {
          return res
            .status(400)
            .send({ message: "parcelId and status are required" });
        }

        const trackingUpdate = {
          parcelId: new ObjectId(parcelId),
          status,
          note: note || "",
          updated_by: updated_by || "system",
          updated_at: new Date(),
        };

        const result = await db
          .collection("trackingUpdates")
          .insertOne(trackingUpdate);
        res.send({ success: true, result });
      } catch (error) {
        console.error("Error adding tracking update:", error);
        res.status(500).send({ message: "Failed to add tracking update" });
      }
    });

    // GET: Fetch tracking updates by parcelId
    app.get("/tracking-updates/:parcelId", async (req, res) => {
      try {
        const { parcelId } = req.params;

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({ message: "Invalid parcel ID" });
        }

        const updates = await db
          .collection("trackingUpdates")
          .find({ parcelId: new ObjectId(parcelId) })
          .sort({ updated_at: -1 })
          .toArray();

        res.send(updates);
      } catch (error) {
        console.error("Error fetching tracking updates:", error);
        res.status(500).send({ message: "Failed to fetch tracking updates" });
      }
    });

    // payment history api
    app.post("/payments", async (req, res) => {
      const { parcelId, userEmail, amount, transactionId, paymentMethod } =
        req.body;

      try {
        // Update parcel's payment status
        const parcelUpdateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { paymentStatus: "paid" } }
        );

        // Record payment
        const paymentDoc = {
          parcelId: new ObjectId(parcelId),
          userEmail,
          amount,
          transactionId,
          paymentMethod,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded and parcel marked as paid",
          parcelUpdateResult,
          paymentResult,
        });
      } catch (error) {
        console.error("Payment processing failed:", error);
        res.status(500).send({ message: "Payment processing failed" });
      }
    });

    // payment history GET
    app.get("/payments/user/:email", async (req, res) => {
      const userEmail = req.params.email;

      try {
        const payments = await paymentsCollection
          .find({ userEmail })
          .sort({ paid_at: -1 }) // latest first
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("Error fetching user payments:", error);
        res.status(500).send({ message: "Failed to fetch user payments" });
      }
    });

    // stripe payment intent api
    app.post("/create-payment-intent", async (req, res) => {
      const amountsInCents = req.body.amountsInCents;
      try {
        // const { amount, currency } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountsInCents, // amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Sample route
app.get("/", (req, res) => {
  res.send("Parcel server is running 🚀");
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
