package main

type Worker interface { Run(string) string }
type Service struct{}
func (Service) Run(value string) string { return value }
func dispatch(worker Worker) string { return worker.Run("x") }
func main() { _ = dispatch(Service{}) }
