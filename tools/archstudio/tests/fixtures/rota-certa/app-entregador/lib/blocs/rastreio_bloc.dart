import 'package:flutter_bloc/flutter_bloc.dart';

import '../repositories/posicao_repository.dart';

class RastreioBloc extends Cubit<bool> {
  RastreioBloc() : super(false);
  final _repositorio = PosicaoRepository();

  void iniciar() {
    _repositorio.acompanhar();
    emit(true);
  }
}
