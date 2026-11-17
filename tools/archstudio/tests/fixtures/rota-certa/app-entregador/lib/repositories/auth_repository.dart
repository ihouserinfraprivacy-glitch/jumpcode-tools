import '../data/api/api_client.dart';

class AuthRepository {
  final _api = ApiClient();

  Future<void> entrar(String usuario, String senha) => _api.post('/login', {'usuario': usuario, 'senha': senha});
}
