import 'package:flutter_bloc/flutter_bloc.dart';

import '../repositories/auth_repository.dart';

class AuthEstado {
  const AuthEstado({this.logado = false});
  final bool logado;
}

class AuthBloc extends Cubit<AuthEstado> {
  AuthBloc() : super(const AuthEstado());
  final _repositorio = AuthRepository();

  Future<void> entrar(String usuario, String senha) async {
    await _repositorio.entrar(usuario, senha);
    emit(const AuthEstado(logado: true));
  }
}
