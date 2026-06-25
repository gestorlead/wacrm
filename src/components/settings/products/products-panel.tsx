'use client';

// ============================================================
// ProductsPanel — Settings → Products & services
//
// CRUD for the products/services catalog (migration 036). Each product is
// a one-time purchase or a subscription; subscriptions carry a billing
// period. Catalog management is admin-only (RLS); the UI hides mutating
// controls for non-admins. Deals attach these as line items, deriving the
// deal value from Σ(quantity × unit_price).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Package, Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { formatCurrency } from '@/lib/currency';
import type { BillingPeriod, Product, ProductType } from '@/types';

const BILLING_PERIODS: { value: BillingPeriod; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'annual', label: 'Annual' },
];

const BILLING_LABEL: Record<BillingPeriod, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Semiannual',
  annual: 'Annual',
};

interface EditorState {
  editing: Product | null;
  name: string;
  description: string;
  type: ProductType;
  price: string;
  billingPeriod: BillingPeriod;
  active: boolean;
}

const EMPTY_EDITOR: EditorState = {
  editing: null,
  name: '',
  description: '',
  type: 'one_time',
  price: '',
  billingPeriod: 'monthly',
  active: true,
};

export function ProductsPanel() {
  const { defaultCurrency } = useAuth();
  const canManage = useCan('edit-settings');

  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/products');
      if (!res.ok) throw new Error('Failed to load');
      const data = (await res.json()) as { products?: Product[] };
      setItems(data.products ?? []);
    } catch {
      toast.error('Could not load products.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

  const openCreate = () => {
    setEditor(EMPTY_EDITOR);
    setDialogOpen(true);
  };

  const openEdit = (row: Product) => {
    setEditor({
      editing: row,
      name: row.name,
      description: row.description ?? '',
      type: row.type,
      price: String(row.price ?? ''),
      billingPeriod: row.billing_period ?? 'monthly',
      active: row.active,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const name = editor.name.trim();
    if (!name) {
      toast.error('Name is required.');
      return;
    }
    const price = parseFloat(editor.price);
    if (!Number.isFinite(price) || price < 0) {
      toast.error('Enter a valid price.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name,
        description: editor.description.trim() || null,
        type: editor.type,
        price,
        billing_period: editor.type === 'subscription' ? editor.billingPeriod : null,
        active: editor.active,
      };
      const res = editor.editing
        ? await fetch(`/api/products/${editor.editing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not save product.');
        return;
      }
      toast.success(editor.editing ? 'Product updated.' : 'Product created.');
      setDialogOpen(false);
      setEditor(EMPTY_EDITOR);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: Product) => {
    setDeletingId(row.id);
    try {
      const res = await fetch(`/api/products/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not delete product.');
        return;
      }
      setItems((prev) => prev.filter((p) => p.id !== row.id));
      toast.success('Product deleted.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Products &amp; services</h2>
        <p className="text-sm text-muted-foreground">
          A reusable catalog you attach to deals as line items. Mark a product as a
          subscription to track its billing period — the deal value is the sum of its items.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products…"
            className="pl-9"
          />
        </div>
        {canManage && (
          <Button onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Package className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {search ? 'No products match your search.' : 'No products yet.'}
            </p>
            {!search && canManage && (
              <Button variant="outline" size="sm" onClick={openCreate}>
                <Plus className="mr-1.5 h-4 w-4" />
                Create your first
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((row) => (
            <div key={row.id} className="flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{row.name}</span>
                  <Badge variant={row.type === 'subscription' ? 'default' : 'secondary'}>
                    {row.type === 'subscription'
                      ? `Subscription · ${BILLING_LABEL[row.billing_period ?? 'monthly']}`
                      : 'One-time'}
                  </Badge>
                  {!row.active && <Badge variant="outline">Archived</Badge>}
                </div>
                {row.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {row.description}
                  </p>
                )}
                <p className="mt-1 text-sm font-semibold text-primary">
                  {formatCurrency(row.price, defaultCurrency)}
                  {row.type === 'subscription' && (
                    <span className="font-normal text-muted-foreground">
                      {' '}/ {BILLING_LABEL[row.billing_period ?? 'monthly'].toLowerCase()}
                    </span>
                  )}
                </p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(row)}
                    title="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(row)}
                    disabled={deletingId === row.id}
                    title="Delete"
                  >
                    {deletingId === row.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor.editing ? 'Edit product' : 'New product'}</DialogTitle>
            <DialogDescription>
              A product or service you can add to deals. Subscriptions require a billing period.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="prod-name">Name</Label>
              <Input
                id="prod-name"
                value={editor.name}
                onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))}
                placeholder="e.g. English Course — Intermediate"
                maxLength={200}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="prod-description">Description</Label>
              <Textarea
                id="prod-description"
                value={editor.description}
                onChange={(e) => setEditor((s) => ({ ...s, description: e.target.value }))}
                placeholder="Optional notes about this product…"
                rows={2}
                maxLength={2000}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex gap-2">
                {(['one_time', 'subscription'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setEditor((s) => ({ ...s, type }))}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      editor.type === type
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {type === 'one_time' ? 'One-time' : 'Subscription'}
                    <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                      {type === 'one_time' ? 'Single purchase' : 'Recurring billing'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="prod-price">Price ({defaultCurrency})</Label>
                <Input
                  id="prod-price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={editor.price}
                  onChange={(e) => setEditor((s) => ({ ...s, price: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
              {editor.type === 'subscription' && (
                <div className="space-y-1.5">
                  <Label htmlFor="prod-period">Billing period</Label>
                  <select
                    id="prod-period"
                    value={editor.billingPeriod}
                    onChange={(e) =>
                      setEditor((s) => ({ ...s, billingPeriod: e.target.value as BillingPeriod }))
                    }
                    className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                  >
                    {BILLING_PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {editor.editing && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={!editor.active}
                  onChange={(e) => setEditor((s) => ({ ...s, active: !e.target.checked }))}
                  className="h-4 w-4 rounded border-border"
                />
                Archive this product (hide it from deal pickers)
              </label>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {editor.editing ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
