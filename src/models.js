import mongoose from 'mongoose';
const { Schema } = mongoose;

export const normKey = (k) => String(k).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const User = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'operator'], default: 'operator' },
}, { timestamps: true });

const Field = new Schema({ key: String, norm: String, value: String, confidence: Number }, { _id: false });

const Rec = new Schema({
  vendor: { type: String, trim: true, default: '' },
  fields: [Field],
  source: { type: String, enum: ['scan', 'upload', 'manual'], default: 'manual' },
  rawText: String,
  image: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdByName: String,
}, { timestamps: true });
Rec.index({ vendor: 1, _id: -1 });
Rec.index({ 'fields.norm': 1 });

export const UserModel = mongoose.model('User', User);
export const Record = mongoose.model('Record', Rec);
