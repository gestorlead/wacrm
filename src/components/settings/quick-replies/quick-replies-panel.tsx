'use client';

// ============================================================
// QuickRepliesPanel — Settings → Quick replies
//
// CRUD for saved canned messages ("mensagens prontas"), triggered by
// typing `/` in the inbox composer. Two scopes share the list:
//   * Shared   — visible to the whole account; only admins manage them.
//   * Personal — private to the current agent; they manage their own.
//
// Permissions are enforced server-side (RLS, migration 035). The UI only
// hides controls the caller can't use: non-admins don't see the "Shared"
// scope toggle and can't edit/delete shared rows.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Search, Trash2, Zap } from 'lucide-react';

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
import type { QuickReply, QuickReplyScope } from '@/types';

/** Tokens the composer resolves at insert time — shown as a cheatsheet. */
const VARIABLE_HINTS = [
  '{{contact.name}}',
  '{{contact.first_name}}',
  '{{contact.phone}}',
  '{{agent.name}}',
  '{{agent.first_name}}',
];

interface EditorState {
  /** The row being edited, or null when creating. */
  editing: QuickReply | null;
  shortCode: string;
  content: string;
  scope: QuickReplyScope;
}

const EMPTY_EDITOR: EditorState = {
  editing: null,
  shortCode: '',
  content: '',
  scope: 'personal',
};

export function QuickRepliesPanel() {
  const { user } = useAuth();
  const canManageShared = useCan('edit-settings');

  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quick-replies');
      if (!res.ok) throw new Error('Failed to load');
      const data = (await res.json()) as { quickReplies?: QuickReply[] };
      setItems(data.quickReplies ?? []);
    } catch {
      toast.error('Could not load quick replies.');
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
      (r) =>
        r.short_code.toLowerCase().includes(q) ||
        r.content.toLowerCase().includes(q),
    );
  }, [items, search]);

  const openCreate = () => {
    setEditor({ ...EMPTY_EDITOR, scope: canManageShared ? 'shared' : 'personal' });
    setDialogOpen(true);
  };

  const openEdit = (row: QuickReply) => {
    setEditor({
      editing: row,
      shortCode: row.short_code,
      content: row.content,
      scope: row.owner_user_id === null ? 'shared' : 'personal',
    });
    setDialogOpen(true);
  };

  /** Whether the caller may mutate a given row (owner, or admin for shared). */
  const canMutate = useCallback(
    (row: QuickReply) =>
      row.owner_user_id === user?.id ||
      (row.owner_user_id === null && canManageShared),
    [user?.id, canManageShared],
  );

  const handleSave = async () => {
    const shortCode = editor.shortCode.trim();
    const content = editor.content.trim();
    if (!shortCode || !content) {
      toast.error('Short code and message are required.');
      return;
    }
    setSaving(true);
    try {
      const res = editor.editing
        ? await fetch(`/api/quick-replies/${editor.editing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ short_code: shortCode, content }),
          })
        : await fetch('/api/quick-replies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ short_code: shortCode, content, scope: editor.scope }),
          });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not save quick reply.');
        return;
      }
      toast.success(editor.editing ? 'Quick reply updated.' : 'Quick reply created.');
      setDialogOpen(false);
      setEditor(EMPTY_EDITOR);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: QuickReply) => {
    setDeletingId(row.id);
    try {
      const res = await fetch(`/api/quick-replies/${row.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Could not delete quick reply.');
        return;
      }
      setItems((prev) => prev.filter((r) => r.id !== row.id));
      toast.success('Quick reply deleted.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Quick replies</h2>
        <p className="text-sm text-muted-foreground">
          Saved messages your team can drop into a chat by typing{' '}
          <code className="rounded bg-muted px-1 py-px text-xs">/</code> in the composer.
          Use variables like{' '}
          <code className="rounded bg-muted px-1 py-px text-xs">{'{{contact.name}}'}</code> to
          personalize them.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search quick replies…"
            className="pl-9"
          />
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Zap className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {search ? 'No quick replies match your search.' : 'No quick replies yet.'}
            </p>
            {!search && (
              <Button variant="outline" size="sm" onClick={openCreate}>
                <Plus className="mr-1.5 h-4 w-4" />
                Create your first
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {filtered.map((row) => {
            const mutable = canMutate(row);
            return (
              <div key={row.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">
                      <span className="text-muted-foreground">/</span>
                      {row.short_code}
                    </span>
                    <Badge variant={row.owner_user_id === null ? 'default' : 'secondary'}>
                      {row.owner_user_id === null ? 'Shared' : 'Personal'}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {row.content}
                  </p>
                </div>
                {mutable && (
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
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor.editing ? 'Edit quick reply' : 'New quick reply'}
            </DialogTitle>
            <DialogDescription>
              Short code triggers the reply after <code>/</code>; the message is what gets
              inserted.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="qr-short-code">Short code</Label>
              <Input
                id="qr-short-code"
                value={editor.shortCode}
                onChange={(e) => setEditor((s) => ({ ...s, shortCode: e.target.value }))}
                placeholder="saudacao"
                maxLength={100}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="qr-content">Message</Label>
              <Textarea
                id="qr-content"
                value={editor.content}
                onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
                placeholder="Olá {{contact.first_name}}, como posso ajudar?"
                rows={4}
                maxLength={5000}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {VARIABLE_HINTS.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() =>
                      setEditor((s) => ({ ...s, content: `${s.content}${token}` }))
                    }
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  >
                    {token}
                  </button>
                ))}
              </div>
            </div>

            {/* Scope is only choosable on create — moving a reply between
                shared/personal would change ownership semantics. Non-admins
                can't create shared rows, so they only see Personal. */}
            {!editor.editing && canManageShared && (
              <div className="space-y-1.5">
                <Label>Visibility</Label>
                <div className="flex gap-2">
                  {(['shared', 'personal'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setEditor((s) => ({ ...s, scope }))}
                      className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                        editor.scope === scope
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {scope}
                      <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                        {scope === 'shared' ? 'Whole team' : 'Only you'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
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
