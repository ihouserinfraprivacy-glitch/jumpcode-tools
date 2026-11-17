import 'package:flutter_bloc/flutter_bloc.dart';

import '../models/entrega.dart';
import '../repositories/entregas_repository.dart';

class EntregasEstado {
  const EntregasEstado(this.entregas);
  final List<Entrega> entregas;
}

class EntregasBloc extends Cubit<EntregasEstado> {
  EntregasBloc() : super(const EntregasEstado([]));
  final _repositorio = EntregasRepository();

  Future<void> carregar() async => emit(EntregasEstado(await _repositorio.doDia()));
}
