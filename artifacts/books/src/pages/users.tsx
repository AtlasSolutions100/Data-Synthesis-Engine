import {
  useListUsers,
  getListUsersQueryKey,
  useUpdateUserRole,
  useDeleteUser,
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, ShieldCheck } from "lucide-react";

export default function Users() {
  const queryClient = useQueryClient();

  const { data: me } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const { data: users, isLoading } = useListUsers({
    query: { queryKey: getListUsersQueryKey() },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });

  const updateRole = useUpdateUserRole({
    mutation: { onSuccess: invalidate },
  });
  const deleteUser = useDeleteUser({
    mutation: { onSuccess: invalidate },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Users
        </h1>
        <p className="text-slate-500 mt-1">
          Owners can manage access and roles. Bookkeepers and owners both have
          full financial access; only owners can manage users.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" /> Team Members
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center py-8 text-slate-500"
                  >
                    Loading users...
                  </TableCell>
                </TableRow>
              ) : users?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center py-8 text-slate-500"
                  >
                    No users yet.
                  </TableCell>
                </TableRow>
              ) : (
                users?.map((u) => {
                  const isSelf = me?.id === u.id;
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium text-slate-900">
                        {u.name || "—"}
                        {isSelf && (
                          <span className="ml-2 text-xs text-slate-400">
                            (you)
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-600">
                        {u.email || "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Select
                            value={u.role}
                            onValueChange={(role) =>
                              updateRole.mutate({
                                id: u.id,
                                data: { role: role as "owner" | "bookkeeper" },
                              })
                            }
                            disabled={isSelf}
                          >
                            <SelectTrigger className="w-[150px] h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="owner">Owner / Admin</SelectItem>
                              <SelectItem value="bookkeeper">
                                Bookkeeper
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {u.role === "owner" && (
                            <Badge variant="secondary" className="text-xs">
                              Admin
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50"
                            disabled={isSelf}
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${u.name || u.email || "this user"}? They will lose access until they sign up again.`,
                                )
                              ) {
                                deleteUser.mutate({ id: u.id });
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
